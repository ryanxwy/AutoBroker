/**
 * Home — the fuller home landing page. Composes Hero +
 * Snapshot/FirstFile + WhatHappensNext + PipelineLedger + WelcomeWizard. Reads
 * profiles + skills via the typed client (useAsync). The active profile (newest
 * row) drives the snapshot + heuristic cards; budget never appears (the snapshot
 * projection has no budget accessor). All four intake entries funnel through
 * the parent's onStartIntake (launchIntakeWithFreshSession).
 */

import type { ApiClient } from "../api/client.js";
import { useAsync } from "../api/useApi.js";
import type { ProfileList, SkillManifest, SkillList } from "../api/wire.js";
import { Hero } from "../home/Hero.js";
import { PipelineLedger } from "../home/PipelineLedger.js";
import { FirstFilePreviewCard, SnapshotCard } from "../home/SnapshotCard.js";
import { toSnapshot, type ProfileSnapshot } from "../home/profileView.js";
import { WelcomeWizard } from "../home/WelcomeWizard.js";
import { WhatHappensNext } from "../home/WhatHappensNext.js";

export interface HomeProps {
  client: ApiClient;
  /** Start intake (fresh unpinned session) — the four entries call this. */
  onStartIntake: () => void;
  /** Run another skill from the ledger (pin-gated; intake exempt). */
  onRunSkill: (skill: SkillManifest) => void;
}

export function Home({ client, onStartIntake, onRunSkill }: HomeProps): JSX.Element {
  const profiles = useAsync<ProfileList>(() => client.listProfiles("active"), []);
  const skills = useAsync<SkillList>(() => client.listSkills(), []);

  const activeProfile: ProfileSnapshot | null =
    profiles.kind === "ok" && profiles.data.length > 0 ? toSnapshot(profiles.data[0]!) : null;
  const profilesEmpty = profiles.kind === "ok" && profiles.data.length === 0;
  const activePin = activeProfile?.id ?? null;

  return (
    <div data-testid="home">
      <WelcomeWizard profilesEmpty={profilesEmpty} onStart={onStartIntake} />

      <div className="hero">
        <Hero onStartSearch={onStartIntake} />
        {activeProfile !== null ? <SnapshotCard snapshot={activeProfile} /> : <FirstFilePreviewCard />}
      </div>

      <WhatHappensNext snapshot={activeProfile} />

      {skills.kind === "ok" && (
        <PipelineLedger skills={skills.data} activePin={activePin} onRun={onRunSkill} />
      )}
      {skills.kind === "error" && (
        <p className="danger-text" role="alert">
          Couldn't load skills: {skills.message}
        </p>
      )}
    </div>
  );
}
