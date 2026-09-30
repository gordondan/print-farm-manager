const fs = require('fs');

const zip = require('./zip-reader');

// The Bambu driver prints exactly Metadata/plate_1.gcode from an uploaded .3mf.
// Return null when the artifact is dispatchable, otherwise an operator-facing error.
function validateSliced3mf(filePath) {
  let names;
  try {
    names = zip.listEntryNames(fs.readFileSync(filePath));
  } catch (_) {
    names = null;
  }
  if (names === null) {
    return 'This file is not a readable .3mf archive. Export it again from your slicer.';
  }
  if (names.includes('Metadata/plate_1.gcode')) return null;

  const otherPlate = names.find((name) => /^Metadata\/plate_\d+\.gcode$/.test(name));
  if (otherPlate) {
    return `This .3mf contains ${otherPlate.replace('Metadata/', '')} but the farm prints plate_1. ` +
      'In your slicer, export just the sliced plate (it becomes plate 1 in the exported file).';
  }
  return 'This .3mf contains no sliced G-code, so the printer would silently ignore it. ' +
    'In Bambu Studio / Orca Slicer: Slice Plate first, then File > Export > Export plate sliced file.';
}

module.exports = { validateSliced3mf };
