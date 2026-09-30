"use client";

import { useState } from "react";
import { Button, ButtonLink } from "../../../components/ui/button";
import { CodeInput } from "../../../components/ui/code-input";
import { IconButton } from "../../../components/ui/icon-button";
import { ListRow } from "../../../components/ui/list-row";
import { Stepper } from "../../../components/ui/stepper";
import { TextField } from "../../../components/ui/text-field";
import { de, errorMessage } from "../../../i18n/de";
import {
  ChevronLeftIcon,
  CopyIcon,
  FlagIcon,
  PlayIcon,
  RotateCcwIcon,
  Settings2Icon,
  Share2Icon,
  SmartphoneIcon,
  ThumbsUpIcon,
} from "../../../lib/ui/icons";
import { ComponentTitle, Demo, Section } from "./section";

const VARIANTS = ["primary", "secondary", "ghost", "destructive"] as const;

/** Button, IconButton, TextField, CodeInput, Stepper, ListRow in allen Zuständen. */
export function ControlsSection() {
  const [name, setName] = useState("Mia");
  const [code, setCode] = useState("");
  const [completed, setCompleted] = useState<string | null>(null);
  const [rounds, setRounds] = useState(3);
  const [rated, setRated] = useState(false);
  const [selectedRow, setSelectedRow] = useState(0);

  return (
    <Section id="controls" title="Bedienelemente">
      <ComponentTitle>Button</ComponentTitle>
      {VARIANTS.map((variant) => (
        <div key={variant} className="flex flex-col gap-3">
          <Demo label={`${variant} · normal`}>
            <Button variant={variant} block icon={variant === "primary" ? PlayIcon : undefined}>
              {variant === "destructive" ? de.dialogs.resign.confirm : de.actions.startGame}
            </Button>
          </Demo>
          <div className="grid grid-cols-2 gap-3">
            <Demo label="hover">
              <Button variant={variant} block data-force="hover">
                {de.actions.join}
              </Button>
            </Demo>
            <Demo label="pressed">
              <Button variant={variant} block data-force="pressed">
                {de.actions.join}
              </Button>
            </Demo>
            <Demo label="focus-visible">
              <Button variant={variant} block data-force="focus">
                {de.actions.join}
              </Button>
            </Demo>
            <Demo label="disabled">
              <Button variant={variant} block disabled>
                {de.actions.join}
              </Button>
            </Demo>
            <Demo label="loading">
              <Button variant={variant} block loading>
                {de.actions.join}
              </Button>
            </Demo>
            <Demo label="kompakt 44">
              <Button variant={variant} size="compact" icon={RotateCcwIcon}>
                {de.actions.rematch}
              </Button>
            </Demo>
          </div>
        </div>
      ))}
      <Demo label="ButtonLink (Navigation)">
        <ButtonLink variant="secondary" href="/dev/ui" block>
          {de.actions.toStart}
        </ButtonLink>
      </Demo>

      <ComponentTitle>IconButton</ComponentTitle>
      <div className="flex flex-wrap items-center gap-3">
        <Demo label="normal">
          <IconButton icon={ChevronLeftIcon} label={de.actions.leaveLobby} />
        </Demo>
        <Demo label="hover">
          <IconButton icon={Settings2Icon} label={de.lobby.settings} data-force="hover" />
        </Demo>
        <Demo label="pressed">
          <IconButton icon={CopyIcon} label={de.lobby.copyCode} data-force="pressed" />
        </Demo>
        <Demo label="focus">
          <IconButton icon={Share2Icon} label={de.lobby.shareLink} data-force="focus" />
        </Demo>
        <Demo label="aktiv (Toggle)">
          <IconButton
            icon={ThumbsUpIcon}
            label={de.review.rateUp}
            pressed={rated}
            onClick={() => setRated((value) => !value)}
          />
        </Demo>
        <Demo label="disabled">
          <IconButton icon={FlagIcon} label={de.review.reported} disabled />
        </Demo>
      </div>

      <ComponentTitle>TextField</ComponentTitle>
      <Demo label="normal">
        <TextField
          label={de.fields.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={16}
        />
      </Demo>
      <Demo label="focus">
        <TextField label={de.fields.name} defaultValue="Ben" data-force="focus" />
      </Demo>
      <Demo label="Fehler">
        <TextField label={de.fields.name} defaultValue="admin" error={errorMessage("NAME_REJECTED")} />
      </Demo>
      <Demo label="disabled">
        <TextField label={de.fields.name} defaultValue="Lea" disabled />
      </Demo>

      <ComponentTitle>CodeInput</ComponentTitle>
      <Demo label={completed ? `vollständig: ${completed}` : "leer – tippen oder einfügen (z. B. „abc-234“)"}>
        <CodeInput value={code} onChange={setCode} onComplete={setCompleted} hint={de.fields.lobbyCodeHint} />
      </Demo>
      <Demo label="aktiv">
        <CodeInput defaultValue="AB" data-force="focus" />
      </Demo>
      <Demo label="gefüllt">
        <CodeInput defaultValue="ABC234" />
      </Demo>
      <Demo label="Fehler">
        <CodeInput defaultValue="XYZ789" error={errorMessage("LOBBY_NOT_FOUND")} />
      </Demo>
      <Demo label="disabled">
        <CodeInput defaultValue="ABC" disabled />
      </Demo>

      <ComponentTitle>Stepper</ComponentTitle>
      <Demo label="bedienbar (1–10)">
        <Stepper label={de.settings.rounds} value={rounds} min={1} max={10} onChange={setRounds} />
      </Demo>
      <Demo label="Untergrenze erreicht">
        <Stepper label={de.settings.questionsPerCategory} value={1} min={1} max={10} onChange={() => {}} />
      </Demo>
      <Demo label="Obergrenze erreicht">
        <Stepper label={de.settings.maxPlayers} value={8} min={2} max={8} onChange={() => {}} />
      </Demo>
      <Demo label="disabled">
        <Stepper label={de.settings.rounds} value={3} min={1} max={10} onChange={() => {}} disabled />
      </Demo>

      <ComponentTitle>ListRow</ComponentTitle>
      <div className="flex flex-col">
        {Object.values(de.report.reasons).map((reason, index) => (
          <ListRow key={reason} selected={selectedRow === index} onClick={() => setSelectedRow(index)}>
            {reason}
          </ListRow>
        ))}
      </div>
      <Demo label="mit Icon · pressed · statisch">
        <div className="flex flex-col">
          <ListRow icon={SmartphoneIcon} onClick={() => {}}>
            {de.pwa.install}
          </ListRow>
          <ListRow icon={FlagIcon} onClick={() => {}} data-force="pressed">
            {de.report.title}
          </ListRow>
          <ListRow>{de.start.rules}</ListRow>
        </div>
      </Demo>
    </Section>
  );
}
