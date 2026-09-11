const fs = require('fs');
const os = require('os');
const path = require('path');

const { readEntry, readEntryToFile } = require('../zip-reader');
const { buildZip } = require('./helpers/build-zip');

function centralDirectoryOffset(buf) {
  return buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
}

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

  test.each([
    ['an oversized entry', buildZip({ 'slices/p1s/part.3mf': 'x'.repeat(1025) }), 1024],
    ['unsupported compression', (() => {
      const archive = buildZip({ 'slices/p1s/part.3mf': 'slice' });
      archive.writeUInt16LE(99, centralDirectoryOffset(archive) + 10);
      return archive;
    })(), 4096],
    ['a malformed archive', Buffer.from('not a zip'), 4096],
  ])('rejects %s without creating the destination', (_description, archive, maxBytes) => {
    const destination = path.join(tempDir, 'part.3mf');

    expect(readEntryToFile(archive, 'slices/p1s/part.3mf', destination, maxBytes)).toBeNull();
    expect(fs.existsSync(destination)).toBe(false);
  });

  test('rejects forged uncompressed metadata before writing', () => {
    const destination = path.join(tempDir, 'part.3mf');
    const archive = buildZip({ 'slices/p1s/part.3mf': 'compressed slice'.repeat(20) }, { deflate: true });
    archive.writeUInt32LE(1, centralDirectoryOffset(archive) + 24);

    expect(readEntry(archive, 'slices/p1s/part.3mf', 4096)).toBeNull();
    expect(readEntryToFile(archive, 'slices/p1s/part.3mf', destination, 4096)).toBeNull();
    expect(fs.existsSync(destination)).toBe(false);
  });
});
