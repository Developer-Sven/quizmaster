// Typen zu service-user.cjs (gemeinsam für ecosystem.config.js und das Deploy-Werkzeug).

export declare const SERVICE_USER: "quizmaster";
export declare const NO_HOME: "/nonexistent";

export interface PasswdEntry {
  name: string;
  /** null, wenn das Feld keine gültige uid ist */
  uid: number | null;
  gid: number | null;
  home: string;
  shell: string;
}

export interface GroupEntry {
  name: string;
  gid: number | null;
  members: string[];
}

export interface ServiceUserIdentity {
  kind: "service";
  user: string;
  uid: number;
  gid: number;
  /** Name der primären Gruppe */
  group: string;
  home: string;
  shell: string;
  /** Weitere Konten in der primären Gruppe (nur mit `allowSharedGroup` möglich, sonst Fehler) */
  sharedWith: string[];
}

export interface RootFallbackIdentity {
  kind: "root";
  /** Benutzer, der fehlt */
  user: string;
  uid: 0;
  gid: 0;
  reason: string;
}

export type ServiceIdentity = ServiceUserIdentity | RootFallbackIdentity;

export interface IdentityOptions {
  user: string;
  /** Fehlt der Benutzer, ist das ein Fehler (sonst Rückfall auf root). */
  required?: boolean;
  /** Primäre Gruppe darf weitere Konten enthalten (nur Tests des Deploy-Werkzeugs). */
  allowSharedGroup?: boolean;
}

export declare function parsePasswd(text: string): PasswdEntry[];
export declare function parseGroup(text: string): GroupEntry[];
export declare function resolveServiceIdentity(
  options: IdentityOptions & { passwd: string; group: string },
): ServiceIdentity;
export declare function readServiceIdentity(options: IdentityOptions): ServiceIdentity;
export declare function userNameOf(uid: number, passwd: string): string | null;
