export const demoMachine = {
  id: "demo-multichannel",
  name: "Demo Multichannel Machine",
  controller: "Generic",
  executionUnits: [{
    id: "unit-1",
    name: "Execution Unit 1",
    tracks: [
      { id: "track-1", name: "Main Track", channel: 1 },
      { id: "track-2", name: "Secondary Track", channel: 2 },
      { id: "track-3", name: "Channel-3", channel: 3 },
    ],
  }],
} as const;

export const defaultTrack = { ...demoMachine.executionUnits[0].tracks[0], unitId: demoMachine.executionUnits[0].id };

export const demoTracks = demoMachine.executionUnits.flatMap((unit) =>
  unit.tracks.map((track) => ({ ...track, unitId: unit.id })),
);

export function trackKey(track: { unitId: string; id: string }) {
  return `${track.unitId}/${track.id}`;
}
