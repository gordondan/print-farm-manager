const fs = require('fs');
const os = require('os');
const path = require('path');

const { readEntryToFile } = require('../zip-reader');
const { buildZip } = require('./helpers/build-zip');

describe('readEntryToFile', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-reader-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('extracts a deflated entry after validating it', () => {
    const destination = path.join(tempDir, 'nested', 'part.3mf');
    const archive = buildZip({ 'slices/p1s/part.3mf': 'compressed slice'.repeat(200) }, { deflate: true });

    expect(readEntryToFile(archive, 'slices/p1s/part.3mf', destination, 4096)).toBe(destination);
    expect(fs.readFileSync(destination, 'utf8')).toBe('compressed slice'.repeat(200));
  });

  test('rejects a traversal entry name without creating the destination', () => {
    const destination = path.join(tempDir, 'part.stl');
    const archive = buildZip({ '../escape.stl': 'not safe' });

    expect(readEntryToFile(archive, '../escape.stl', destination, 1024)).toBeNull();
    expect(fs.existsSync(destination)).toBe(false);
  });
});
