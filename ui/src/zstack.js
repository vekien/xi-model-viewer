// One monotonic z-index shared by every draggable window — the floating panels
// (Floating.jsx), the Ability Mixer, the Camera Sequencer, and the modal windows
// (App.jsx › raiseModal) — so whichever the user touches last sits on top of all
// the others, whatever its type. Before this, the floating panels ran their own
// counter (25+) that could never reach the modal counter (10000+), so the mixer
// and sequencer always covered them.
//
// It starts above every static fallback z in the app (the highest being the
// Settings / About dialogs at 5000) and stays well below tooltips and menu
// dropdowns (100000+), which are meant to float over the whole window stack.
let z = 10000;

/** The next z for a window being opened or brought to the front. */
export const nextZ = () => (z += 1);
