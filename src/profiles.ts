export const DEFAULT_PROFILE_ID = "jared";

export interface Profile {
  id: string;
  name: string;
}

export const PROFILES: Profile[] = [
  { id: "jared", name: "Jared" },
  { id: "wendy", name: "Wendy" },
];

export function isKnownProfileId(id: string | undefined | null): id is string {
  return Boolean(id && PROFILES.some((profile) => profile.id === id));
}

export function resolveProfileId(hash = typeof location !== "undefined" ? location.hash : ""): string {
  const raw = hash.replace(/^#/, "").split("/")[0]?.trim().toLowerCase() ?? "";
  return isKnownProfileId(raw) ? raw : DEFAULT_PROFILE_ID;
}

export function profileById(id: string): Profile {
  return PROFILES.find((profile) => profile.id === id) ?? PROFILES[0];
}
