/**
 * Hermetische Tests der Betriebsskripte (infra/ops/*.sh): echte Werkzeuge (bash, gpg, gzip, flock, find), nur
 * mongodump/mongorestore sind Stubs im PATH. Jede Prüfung nutzt eigene Temp-Verzeichnisse, eine synthetische
 * Env-Datei (Dummy-Werte) und `--no-alert` – nichts berührt /var/backups, /var/lib, Cron oder echte Datenbanken.
 */
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const OPS = join(ROOT, "infra", "ops");
const base = mkdtempSync(join(tmpdir(), "qm-infra-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let counter = 0;
const dir = (name: string) => {
  const path = join(base, `${name}-${++counter}`);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
};

const PASSPHRASE = "test-passphrase-nur-fuer-tests-1234";
const syntheticEnv = (extra: Record<string, string> = {}) => {
  const file = join(dir("env"), "synthetic.env");
  const values: Record<string, string> = {
    QUIZMASTER_DOMAIN: "quiz.example.com",
    MONGODB_URI: "mongodb://user:geheimes-passwort@127.0.0.1:1/?tls=true",
    MONGODB_DB: "quizmaster",
    TEST_MONGODB_DB: "quizmaster_test",
    SESSION_SECRET: "a".repeat(40),
    REALTIME_TICKET_SECRET: "b".repeat(40),
    IP_HASH_SECRET: "c".repeat(40),
    METRICS_TOKEN: "d".repeat(40),
    ...extra,
  };
  writeFileSync(
    file,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    {
      mode: 0o600,
    },
  );
  return file;
};
const passphraseFile = () => {
  const file = join(dir("pass"), "passphrase");
  writeFileSync(file, PASSPHRASE, { mode: 0o600 });
  return file;
};

/** Stubs für mongodump/mongorestore: protokollieren argv und ob die URI per --config kam. */
const stubs = dir("stubs");
const record = join(stubs, "record");
mkdirSync(record);
writeFileSync(
  join(stubs, "mongodump"),
  `#!/usr/bin/env bash
printf '%s\\n' "$@" >"${record}/dump-argv"
while [ $# -gt 0 ]; do
  if [ "$1" = "--config" ]; then cat "$2" >"${record}/dump-config"; shift 2; else shift; fi
done
printf 'fake mongodump archive' | gzip -c
printf '2026-10-01T03:30:02.200+0200\\tdone dumping \`quizmaster.questions\` (3 documents)\\n' >&2
printf '2026-10-01T03:30:02.210+0200\\tdone dumping \`quizmaster.appConfig\` (1 document)\\n' >&2
`,
  { mode: 0o755 },
);
writeFileSync(
  join(stubs, "mongorestore"),
  `#!/usr/bin/env bash
printf '%s\\n' "$@" >"${record}/restore-argv"
while [ $# -gt 0 ]; do
  if [ "$1" = "--config" ]; then cat "$2" >"${record}/restore-config"; shift 2; else shift; fi
done
cat >/dev/null
if [ -n "\${STUB_RESTORED:-}" ]; then
  printf '%s document(s) restored successfully. %s document(s) failed to restore.\\n' "$STUB_RESTORED" "\${STUB_FAILED:-0}" >&2
fi
exit 0
`,
  { mode: 0o755 },
);
/** pm2 und Deploy-Werkzeug als Stubs für restore.sh (protokollieren Aufrufe). */
writeFileSync(join(stubs, "pm2"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >>"${record}/pm2-calls"\n`, {
  mode: 0o755,
});
writeFileSync(
  join(stubs, "deploy-stub.mjs"),
  `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(record, "deploy-calls"))}, process.argv.slice(2).join(" ") + "\\n");
process.exit(Number(process.env.STUB_RESTART_CODE ?? 0));
`,
);

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Skript asynchron ausführen (Tests mit HTTP-Servern im selben Prozess). */
function bash(args: readonly string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolvePromise) => {
    execFile(
      "bash",
      args,
      {
        cwd: ROOT,
        env: {
          PATH: `${stubs}:${process.env.PATH ?? ""}`,
          HOME: process.env.HOME ?? "/root",
          LANG: "C.UTF-8",
          QM_NODE: process.execPath,
          GNUPGHOME: dir("gnupg"),
          ...env,
        },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolvePromise({ code, stdout, stderr });
      },
    );
  });
}

const touchHoursAgo = (file: string, hours: number) => {
  const when = new Date(Date.now() - hours * 3_600_000);
  utimesSync(file, when, when);
};

describe("lib.sh", () => {
  it("qm_streak zählt aufeinanderfolgende Fehlschläge und setzt bei Erfolg zurück", async () => {
    const state = dir("state");
    const script = `. ${OPS}/lib.sh; qm_streak cf fail; qm_streak cf fail; qm_streak cf ok; qm_streak cf fail`;
    const result = await bash(["-c", script], { QM_STATE_DIR: state });
    expect(result.stdout.trim().split("\n")).toEqual(["1", "2", "0", "1"]);
    expect(statSync(state).mode & 0o777).toBe(0o700);
  });

  it("qm_require_committed_tools: unbeaufsichtigte Läufe nur mit committeten Betriebswerkzeugen", async () => {
    const repo = dir("repo");
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        stdio: "ignore",
      });
    git("init", "-q");
    mkdirSync(join(repo, "infra", "ops"), { recursive: true });
    mkdirSync(join(repo, "infra", "caddy"), { recursive: true });
    mkdirSync(join(repo, "apps"), { recursive: true });
    for (const file of ["infra/ops/backup.sh", "infra/caddy/cloudflare-ips.txt", "apps/page.tsx"]) {
      writeFileSync(join(repo, file), "v1\n");
    }
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const check = (unattended: string) =>
      bash(["-c", `. ${OPS}/lib.sh; QM_ROOT=${repo}; qm_require_committed_tools && echo RUN`], {
        QM_UNATTENDED: unattended,
      });

    // Änderungen außerhalb der Betriebswerkzeuge und an der vom Cron gepflegten IP-Liste stören nicht.
    writeFileSync(join(repo, "apps/page.tsx"), "v2\n");
    writeFileSync(join(repo, "infra/caddy/cloudflare-ips.txt"), "v2\n");
    expect((await check("1")).stdout).toContain("RUN");

    writeFileSync(join(repo, "infra/ops/backup.sh"), "halbfertig\n");
    const blocked = await check("1");
    expect(blocked.code).not.toBe(0);
    expect(blocked.stdout).not.toContain("RUN");
    expect(blocked.stderr).toContain("infra/ops/backup.sh");
    // Manuelle Läufe (ohne QM_UNATTENDED) bleiben möglich.
    expect((await check("0")).stdout).toContain("RUN");
  });
});

describe("backup.sh", () => {
  it("verschlüsselt, prüft, schreibt Manifest (URI nur über --config) und hält die Aufbewahrung ein", async () => {
    const out = dir("backups");
    // Alte Archive: die neuesten 3 bleiben immer, ältere als 14 Tage werden gelöscht.
    const old = [20, 21, 22, 23].map((days, index) => {
      const file = join(out, `quizmaster-202609${String(index + 1).padStart(2, "0")}-033000.archive.gz.gpg`);
      writeFileSync(file, "alt", { mode: 0o600 });
      writeFileSync(file.replace(".archive.gz.gpg", ".manifest.json"), "{}", { mode: 0o600 });
      touchHoursAgo(file, days * 24);
      return file;
    });
    const result = await bash([
      join(OPS, "backup.sh"),
      "--env-file",
      syntheticEnv(),
      "--passphrase-file",
      passphraseFile(),
      "--out-dir",
      out,
      "--no-files",
      "--no-alert",
    ]);
    expect(result.stderr).not.toContain("FEHLER");
    expect(result.code).toBe(0);

    const archives = readdirSync(out).filter((name) => /^quizmaster-\d{8}-\d{6}\.archive\.gz\.gpg$/.test(name));
    const fresh = archives.map((name) => join(out, name)).find((file) => !old.includes(file)) ?? "";
    expect(existsSync(fresh)).toBe(true);
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
    const plain = execFileSync(
      "bash",
      [
        "-c",
        `gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$1" --decrypt "$2" | gzip -dc`,
        "-",
      ].concat([passphraseFile(), fresh]),
      { env: { ...process.env, GNUPGHOME: dir("gnupg") } },
    ).toString();
    expect(plain).toBe("fake mongodump archive");

    const manifest = JSON.parse(readFileSync(fresh.replace(".archive.gz.gpg", ".manifest.json"), "utf8")) as {
      database: string;
      collections: Record<string, number>;
      totalDocuments: number;
    };
    expect(manifest).toMatchObject({ database: "quizmaster", collections: { appConfig: 1, questions: 3 } });
    expect(manifest.totalDocuments).toBe(4);

    // Zugangsdaten nie auf der Kommandozeile, sondern als --config-Datei.
    expect(readFileSync(join(record, "dump-argv"), "utf8")).not.toContain("mongodb://");
    expect(readFileSync(join(record, "dump-config"), "utf8")).toMatch(/^uri: "mongodb:\/\/user:/);
    expect(result.stdout + result.stderr).not.toContain("geheimes-passwort");

    // Aufbewahrung: neu + 20 + 21 Tage bleiben (neueste 3), 22 und 23 Tage samt Manifest gelöscht.
    expect(old.map((file) => existsSync(file))).toEqual([true, true, false, false]);
    expect(existsSync(old[3]?.replace(".archive.gz.gpg", ".manifest.json") ?? "")).toBe(false);
  });
});

describe("restore-test.sh", () => {
  it("bricht ab, wenn das neueste Backup älter als --max-age-hours ist (Standard 36 h)", async () => {
    const backups = dir("backups");
    const archive = join(backups, "quizmaster-20260929-033000.archive.gz.gpg");
    writeFileSync(archive, "x", { mode: 0o600 });
    touchHoursAgo(archive, 40);
    const result = await bash([
      join(OPS, "restore-test.sh"),
      "--backup-dir",
      backups,
      "--target-env-file",
      syntheticEnv(),
      "--passphrase-file",
      passphraseFile(),
      "--no-alert",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("ist 40 h alt (erlaubt 36 h)");
    expect(result.stderr).toContain("Schritt „Archiv wählen“");
  });
});

describe("check-backup.sh", () => {
  const fill = (hoursDb: number, options: { manifest?: boolean } = {}) => {
    const backups = dir("backups");
    const archive = join(backups, "quizmaster-20261001-033000.archive.gz.gpg");
    writeFileSync(archive, "x", { mode: 0o600 });
    if (options.manifest !== false) writeFileSync(archive.replace(".archive.gz.gpg", ".manifest.json"), "{}");
    touchHoursAgo(archive, hoursDb);
    const files = join(backups, "quizmaster-files-20261001-033000.tar.gz.gpg");
    writeFileSync(files, "x", { mode: 0o600 });
    touchHoursAgo(files, 5);
    return backups;
  };
  const check = (backups: string) => bash([join(OPS, "check-backup.sh"), "--backup-dir", backups, "--no-alert"]);

  it("frisches Backup mit Manifest → ok", async () => {
    const result = await check(fill(5));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Backup-Kontrolle ok");
  });

  it("zu altes Backup, fehlendes Manifest oder leeres Verzeichnis → Alarm", async () => {
    const stale = await check(fill(30));
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("ist 30 h alt (erlaubt 26 h)");
    expect(stale.stderr).toContain("ALARM (nicht gesendet, --no-alert)");

    const noManifest = await check(fill(1, { manifest: false }));
    expect(noManifest.code).toBe(1);
    expect(noManifest.stderr).toContain("Manifest zu quizmaster-20261001-033000.archive.gz.gpg fehlt");

    const empty = await check(dir("backups"));
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("kein Datenbank-Archiv");
  });
});

describe("healthcheck.sh", () => {
  let web: Server;
  let realtime: Server;
  const answers = { web: 200, realtime: 200, realtimeBody: '{"ok":true}' };
  const listen = (handler: (path: string) => { status: number; body: string }) =>
    new Promise<Server>((resolvePromise) => {
      const server = createServer((req, res) => {
        const { status, body } = handler(req.url ?? "/");
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      });
      server.listen(0, "127.0.0.1", () => resolvePromise(server));
    });
  const port = (server: Server) => (server.address() as AddressInfo).port;

  beforeAll(async () => {
    web = await listen((path) => ({ status: path === "/api/health" ? answers.web : 404, body: '{"ok":true}' }));
    realtime = await listen((path) =>
      path === "/healthz" ? { status: answers.realtime, body: answers.realtimeBody } : { status: 404, body: "" },
    );
  });
  afterAll(() => {
    web.close();
    realtime.close();
  });

  const setup = () => {
    const deploy = dir("deploy");
    mkdirSync(join(deploy, "releases", "a".repeat(40)), { recursive: true });
    symlinkSync(join("releases", "a".repeat(40)), join(deploy, "current"));
    const env = syntheticEnv({ QUIZMASTER_PORT: String(port(web)), REALTIME_PORT: String(port(realtime)) });
    const state = dir("state");
    const run = () =>
      bash(
        [
          join(OPS, "healthcheck.sh"),
          "--env-file",
          env,
          "--deploy-dir",
          deploy,
          "--alert-after-min",
          "0",
          "--no-alert",
        ],
        { QM_STATE_DIR: state },
      );
    return { deploy, run };
  };

  it("gesund (auch 429 = lebt) → keine Ausgabe, kein Alarm", async () => {
    answers.web = 429;
    answers.realtime = 200;
    answers.realtimeBody = '{"ok":true}';
    const result = await setup().run();
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });

  it("Störung → genau ein Alarm, Entwarnung nach Erholung; ok:false zählt als Störung", async () => {
    const { run } = setup();
    answers.web = 200;
    answers.realtime = 200;
    answers.realtimeBody = '{"ok":false}';
    const first = await run();
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("ALARM (nicht gesendet, --no-alert): quizmaster-realtime gestört");
    expect(first.stderr).toContain("HTTP 200 (ok: false)");
    expect(first.stderr).not.toContain("quizmaster-web gestört");

    const second = await run();
    expect(second.stderr).not.toContain("ALARM");

    answers.realtimeBody = '{"ok":true}';
    const recovered = await run();
    expect(recovered.stderr).toContain("Entwarnung: quizmaster-realtime antwortet wieder");
  });

  it("nicht erreichbar (kein Prozess) → Alarm mit HTTP 000; ohne Release oder während eines Deploys → nichts", async () => {
    const { deploy, run } = setup();
    const unreachable = syntheticEnv({ QUIZMASTER_PORT: "1999", REALTIME_PORT: "1998" });
    const down = await bash(
      [
        join(OPS, "healthcheck.sh"),
        "--env-file",
        unreachable,
        "--deploy-dir",
        deploy,
        "--alert-after-min",
        "0",
        "--no-alert",
      ],
      { QM_STATE_DIR: dir("state") },
    );
    expect(down.stderr).toContain("quizmaster-web gestört seit 0 min (HTTP 000");

    writeFileSync(join(deploy, "deploy.lock"), JSON.stringify({ pid: process.pid, command: "deploy" }));
    answers.web = 500;
    expect((await run()).stderr).toBe("");
    rmSync(join(deploy, "deploy.lock"));
    rmSync(join(deploy, "current"));
    expect((await run()).stderr).toBe("");
    answers.web = 200;
  });
});

describe("restore.sh", () => {
  const gpgEncrypt = (plain: string, target: string) =>
    execFileSync(
      "bash",
      [
        "-c",
        'printf "%s" "$3" | gzip -c | gpg --batch --quiet --yes --pinentry-mode loopback --passphrase-file "$1" ' +
          '--symmetric --cipher-algo AES256 --output "$2"',
        "-",
        passphraseFile(),
        target,
        plain,
      ],
      { env: { ...process.env, GNUPGHOME: dir("gnupg") } },
    );
  const setup = () => {
    const backups = dir("backups");
    const archive = join(backups, "quizmaster-20261001-033000.archive.gz.gpg");
    gpgEncrypt("fake archive", archive);
    writeFileSync(
      archive.replace(".archive.gz.gpg", ".manifest.json"),
      `${JSON.stringify({ archive: "x", database: "quizmaster", collections: { questions: 4 }, totalDocuments: 4 }, null, 2)}\n`,
    );
    for (const file of ["pm2-calls", "deploy-calls", "restore-argv", "restore-config"]) {
      rmSync(join(record, file), { force: true });
    }
    const deploy = dir("deploy");
    const run = (args: string[], env: Record<string, string> = {}) =>
      bash(
        [
          join(OPS, "restore.sh"),
          "--backup-dir",
          backups,
          "--env-file",
          syntheticEnv(),
          "--passphrase-file",
          passphraseFile(),
          "--deploy-dir",
          deploy,
          "--no-alert",
          ...args,
        ],
        { QM_PM2_BIN: join(stubs, "pm2"), QM_DEPLOY_TOOL: join(stubs, "deploy-stub.mjs"), ...env },
      );
    const read = (file: string) => (existsSync(join(record, file)) ? readFileSync(join(record, file), "utf8") : "");
    return { backups, deploy, run, read };
  };

  it("ohne --confirm-prod nur der Plan – nichts gestoppt, nichts eingespielt", async () => {
    const { run, read } = setup();
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("4 Dokumente laut Manifest");
    expect(result.stdout).toContain("Nur Plan");
    expect(read("pm2-calls") + read("restore-argv") + read("deploy-calls")).toBe("");
  });

  it("Ernstfall: Sicherheitskopie → Apps stoppen → mongorestore --drop → Apps mit Smoke-Test starten", async () => {
    const { backups, deploy, run, read } = setup();
    const result = await run(["--confirm-prod"], { STUB_RESTORED: "4" });
    expect(result.stderr).not.toContain("FEHLER");
    expect(result.code).toBe(0);
    expect(read("pm2-calls").trim().split("\n")).toEqual([
      "stop quizmaster-watchdog",
      "stop quizmaster-realtime quizmaster-web",
    ]);
    const argv = read("restore-argv");
    expect(argv).toContain("--drop");
    expect(argv).toContain("quizmaster.*");
    expect(argv).not.toContain("mongodb://");
    expect(read("restore-config")).toMatch(/^uri: "mongodb:\/\//);
    expect(read("deploy-calls").trim()).toBe("restart");
    expect(existsSync(join(deploy, "deploy.lock"))).toBe(false);
    // Sicherheitskopie des vorherigen Stands liegt neben dem eingespielten Archiv.
    expect(readdirSync(backups).filter((name) => name.endsWith(".archive.gz.gpg"))).toHaveLength(2);
  });

  it("scheitert das Einspielen, laufen die Apps trotzdem wieder an (und der Fehler wird gemeldet)", async () => {
    const { deploy, run, read } = setup();
    const result = await run(["--confirm-prod", "--no-safety-backup"], { STUB_RESTORED: "2", STUB_FAILED: "2" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("2 Dokumente nicht eingespielt");
    expect(read("deploy-calls").trim()).toBe("restart");
    expect(existsSync(join(deploy, "deploy.lock"))).toBe(false);
  });

  it("falsche Passphrase oder belegte Deploy-Sperre → Abbruch, bevor eine App gestoppt wird", async () => {
    const wrong = setup();
    const wrongPass = join(dir("pass"), "falsch");
    writeFileSync(wrongPass, "ganz-falsche-passphrase-123", { mode: 0o600 });
    const refused = await wrong.run(["--confirm-prod", "--passphrase-file", wrongPass]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("lässt sich nicht entschlüsseln");
    expect(wrong.read("pm2-calls")).toBe("");

    const locked = setup();
    writeFileSync(join(locked.deploy, "deploy.lock"), JSON.stringify({ pid: process.pid, command: "deploy" }));
    const busy = await locked.run(["--confirm-prod", "--no-safety-backup"]);
    expect(busy.code).toBe(1);
    expect(busy.stderr).toContain("Deploy-Sperre belegt");
    expect(locked.read("pm2-calls") + locked.read("deploy-calls")).toBe("");
    expect(existsSync(join(locked.deploy, "deploy.lock"))).toBe(true);
  });
});

describe("install-cron.sh", () => {
  it("verweigert ohne ALERT_WEBHOOK_URL, schreibt sonst alle Jobs mit QM_UNATTENDED=1", async () => {
    const env = syntheticEnv();
    const refused = await bash([join(OPS, "install-cron.sh"), "--env-file", env], { QM_CRON_DIR: dir("cron") });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("ALERT_WEBHOOK_URL fehlt");

    const preview = await bash([join(OPS, "install-cron.sh"), "--dry-run", "--allow-no-webhook", "--env-file", env]);
    expect(preview.code).toBe(0);
    for (const job of ["healthcheck.sh", "backup.sh", "check-backup.sh", "restore-test.sh", "--refresh-ips"]) {
      expect(preview.stdout).toContain(job);
    }
    expect(preview.stdout).toContain("\nQM_UNATTENDED=1\n");
    expect(preview.stdout).toMatch(
      /^\* {4}\* {2}\* {3}\* {8}\* {2}root {2}flock -n \/run\/lock\/quizmaster-healthcheck\.lock/m,
    );
  });

  it.skipIf(process.getuid?.() !== 0)("schreibt /etc/cron.d-Datei atomar mit 644 (Testverzeichnis, root)", async () => {
    const cron = dir("cron");
    const env = syntheticEnv({ ALERT_WEBHOOK_URL: "https://hooks.example.com/test" });
    const result = await bash([join(OPS, "install-cron.sh"), "--env-file", env], {
      QM_CRON_DIR: cron,
      QM_BACKUP_ROOT: dir("backup-root"),
    });
    expect(result.code).toBe(0);
    expect(statSync(join(cron, "quizmaster")).mode & 0o777).toBe(0o644);
    expect(readFileSync(join(cron, "quizmaster"), "utf8")).toContain("check-backup.sh");
    chmodSync(cron, 0o700);
  });
});
