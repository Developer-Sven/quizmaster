"use client";

import { useState } from "react";
import { Avatar, type AvatarSize } from "../../../components/ui/avatar";
import { Button } from "../../../components/ui/button";
import { PlayerRow } from "../../../components/ui/player-row";
import { Podium } from "../../../components/ui/podium";
import { RankingList } from "../../../components/ui/ranking-list";
import { ScorePill } from "../../../components/ui/score-pill";
import { de } from "../../../i18n/de";
import { samplePlayer } from "./sample-data";
import { ComponentTitle, Demo, Section } from "./section";

const SIZES: readonly AvatarSize[] = [24, 32, 40, 56, 88];

const RANKING = [
  { index: 0, place: 1, score: 12, status: "active" },
  { index: 1, place: 2, score: 10, status: "active" },
  { index: 2, place: 2, score: 10, status: "active" },
  { index: 3, place: 4, score: 7, status: "active" },
  { index: 4, place: 5, score: 5, status: "resigned" },
] as const;

/** Avatar, PlayerRow, ScorePill, RankingList, Podium in allen Zuständen. */
export function PeopleSection() {
  const [score, setScore] = useState(7);
  const [podiumRun, setPodiumRun] = useState(0);
  const mia = samplePlayer(0);
  const ben = samplePlayer(1);
  const lea = samplePlayer(2);
  const ranking = RANKING.map((entry) => {
    const player = samplePlayer(entry.index);
    return { ...entry, playerId: player.id, name: player.name, color: player.color };
  });

  return (
    <Section id="people" title="Personen">
      <ComponentTitle>Avatar</ComponentTitle>
      <Demo label="Größen 24 · 32 · 40 · 56 · 88">
        <div className="flex flex-wrap items-end gap-4">
          {SIZES.map((size, index) => (
            <Avatar key={size} name={samplePlayer(index + 3).name} color={samplePlayer(index + 3).color} size={size} />
          ))}
        </div>
      </Demo>
      <div className="flex flex-wrap gap-6">
        <Demo label="offline">
          <Avatar name={lea.name} color={lea.color} size={56} offline label={lea.name} />
        </Demo>
        <Demo label="Host">
          <Avatar name={mia.name} color={mia.color} size={56} host label={mia.name} />
        </Demo>
        <Demo label="geantwortet">
          <Avatar name={ben.name} color={ben.color} size={56} answered label={ben.name} />
        </Demo>
        <Demo label="aufgegeben">
          <Avatar name={lea.name} color={lea.color} size={56} resigned label={lea.name} />
        </Demo>
        <Demo label="Sieger:in">
          <Avatar name={mia.name} color={mia.color} size={56} winner label={mia.name} />
        </Demo>
      </div>

      <ComponentTitle>PlayerRow</ComponentTitle>
      <ul className="flex flex-col">
        <li>
          <PlayerRow name={mia.name} color={mia.color} isHost />
        </li>
        <li>
          <PlayerRow name={ben.name} color={ben.color} onKick={() => {}} />
        </li>
        <li>
          <PlayerRow name={lea.name} color={lea.color} connected={false} onKick={() => {}} />
        </li>
        <li>
          <PlayerRow name={samplePlayer(4).name} color={samplePlayer(4).color} resigned />
        </li>
      </ul>

      <ComponentTitle>ScorePill</ComponentTitle>
      <Demo label="+1 steigt auf, die Zahl zählt hoch">
        <div className="flex items-center gap-4 pt-4">
          <Avatar name={mia.name} color={mia.color} size={40} />
          <ScorePill score={score} />
          <Button variant="secondary" size="compact" onClick={() => setScore((value) => value + 1)}>
            {de.game.pointsGained(1)}
          </Button>
        </div>
      </Demo>

      <ComponentTitle>RankingList</ComponentTitle>
      <RankingList entries={ranking} />

      <ComponentTitle>Podium</ComponentTitle>
      <Podium key={podiumRun} entries={ranking} animate={podiumRun > 0} />
      <Button variant="ghost" size="compact" onClick={() => setPodiumRun((run) => run + 1)}>
        Säulen wachsen lassen
      </Button>
    </Section>
  );
}
