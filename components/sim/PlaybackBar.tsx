"use client";

import { useRef, type JSX } from "react";
import { BEHAVIOUR } from "@/lib/config/coefficients";
import type { SimPlayer } from "./player";
import { usePlaybackSnapshot } from "./useSimulationPlayback";
import { Scrubber } from "./Scrubber";
import { int, litresPerDay, pct } from "./format";

/**
 * The transport for the household simulation, docked over the map. Three
 * rows, quietest last: time (play, restart, where we are, the scrubber), what
 * it means this week (three readings and which future this is), and how to
 * read the map (the key, and the Today / With project comparison).
 */

const PASS_PCT = Math.round(BEHAVIOUR.passThreshold.value * 100);

function Icon(props: { d: string; fill?: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={props.d}
        fill={props.fill ? "currentColor" : "none"}
        stroke={props.fill ? "none" : "currentColor"}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const PLAY = "M5 3.2v9.6L12.6 8Z";
const PAUSE = "M4.6 3.2h2.3v9.6H4.6ZM9.1 3.2h2.3v9.6H9.1Z";
const RESTART = "M3.6 8.2a4.6 4.6 0 1 0 1.5-3.5M4.6 2.4v2.6h2.6";
const PREV = "m9.8 3.8-4.2 4.2 4.2 4.2";
const NEXT = "m6.2 3.8 4.2 4.2-4.2 4.2";

function Readout(props: { label: string; value: string; title: string }): JSX.Element {
  return (
    <div className="simbar-readout" title={props.title}>
      <div className="lbl">{props.label}</div>
      <div className="simbar-value num">{props.value}</div>
    </div>
  );
}

export function PlaybackBar(props: { player: SimPlayer }): JSX.Element | null {
  const { player } = props;
  const snap = usePlaybackSnapshot(player);
  const resumeAfterScrub = useRef(false);

  if (!snap) return null;

  const time = `Year ${snap.year} · Wk ${snap.weekOfYear}`;
  const heldLabel = snap.held === null ? null : snap.held ? "Held" : "Fell short";
  const heldTitle =
    snap.held === null
      ? ""
      : snap.held
        ? `In this future the taps kept serving at least ${PASS_PCT}% of the people they were designed for.`
        : `In this future people served fell below ${PASS_PCT}% of the design.`;

  return (
    <div className="simbar" role="region" aria-label="Household simulation playback">
      <div className="simbar-row">
        <button
          type="button"
          className="simbar-ico primary"
          aria-label={snap.playing ? "Pause" : snap.done ? "Replay" : "Play"}
          title={snap.playing ? "Pause" : snap.done ? "Replay" : "Play"}
          onClick={player.toggle}
        >
          <Icon d={snap.playing ? PAUSE : PLAY} fill />
        </button>
        <button type="button" className="simbar-ico" aria-label="Restart" title="Restart" onClick={player.restart}>
          <Icon d={RESTART} />
        </button>

        <div className="simbar-time">
          <div className="mono num simbar-clock">{time}</div>
          {snap.systemUp ? (
            <div className="lbl" title="What the new system can supply this week">
              {litresPerDay(snap.capacityL)}
            </div>
          ) : (
            <div className="lbl simbar-downlbl" title="The new system is out of service; households fall back to their old sources">
              System down
            </div>
          )}
        </div>

        <Scrubber
          weeks={snap.weeks}
          elapsed={snap.elapsed}
          designed={snap.designedServed}
          trace={snap.trace}
          valueText={time}
          onSeek={player.seek}
          onScrubStart={() => {
            resumeAfterScrub.current = player.getSnapshot().playing;
            player.pause();
          }}
          onScrubEnd={() => {
            if (resumeAfterScrub.current && !player.getSnapshot().done) player.play();
            resumeAfterScrub.current = false;
          }}
        />
      </div>

      <div className="simbar-row simbar-readouts">
        <Readout
          label="People served"
          value={int(snap.served)}
          title={`People whose water comes from the new taps this week (designed for ${int(snap.designedServed)})`}
        />
        <Readout
          label="≤ 30 min trip"
          value={pct(snap.under30Share)}
          title="Of the people served, the share whose round trip, queue included, is 30 minutes or less"
        />
        <Readout
          label="Hours saved / day"
          value={int(snap.hoursSaved)}
          title="Hours of walking and queueing the whole population saves each day, against no project"
        />

        <div className="simbar-future">
          <button type="button" className="simbar-chev" aria-label="Previous future" onClick={player.prevFuture}>
            <Icon d={PREV} />
          </button>
          <span className="mono num simbar-futurelbl">
            Future {snap.futureIndex + 1} / {snap.futureCount}
          </span>
          <button type="button" className="simbar-chev" aria-label="Next future" onClick={player.nextFuture}>
            <Icon d={NEXT} />
          </button>
          {heldLabel ? (
            <span
              className={`simbar-held ${snap.held ? "ok" : "bad"}`}
              role="img"
              aria-label={`This future ${snap.held ? "held" : "fell short"}`}
              title={`${heldLabel}. ${heldTitle}`}
            />
          ) : null}
        </div>
      </div>

      <div className="simbar-row simbar-foot">
        <div className="simbar-keys">
          <span className="simbar-key">
            <i className="simbar-ramp" aria-hidden="true" />
            Time carrying water
          </span>
          <span className="simbar-key">
            <i className="simbar-dot" aria-hidden="true" />
            Served by the new taps
          </span>
        </div>

        <div className="seg simbar-seg" role="group" aria-label="Compare the map">
          <button
            type="button"
            className={snap.mode === "today" ? "on" : ""}
            aria-pressed={snap.mode === "today"}
            onClick={() => player.setMode("today")}
          >
            Today
          </button>
          <button
            type="button"
            className={snap.mode === "project" ? "on" : ""}
            aria-pressed={snap.mode === "project"}
            onClick={() => player.setMode("project")}
          >
            With project
          </button>
        </div>
      </div>
    </div>
  );
}
