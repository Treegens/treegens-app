import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildGwrDownloadFilename,
  buildGwrManifestCsv,
  csvCell,
  gwrFileExtension,
  slugify,
  utcStamp,
} from './gwrVideoNaming'

test('extension comes from the filename first, then the mime type', () => {
  assert.equal(gwrFileExtension('clip.MOV', 'video/quicktime'), 'mov')
  assert.equal(gwrFileExtension('blob', 'video/webm'), 'webm')
  assert.equal(gwrFileExtension(undefined, 'video/quicktime'), 'mov')
  assert.equal(gwrFileExtension('', 'application/octet-stream'), 'mp4')
  // iOS sometimes hands over `.tmp`; never store a clip under that.
  assert.equal(gwrFileExtension('upload.tmp', 'video/mp4'), 'mp4')
})

test('slugify keeps names filesystem-safe', () => {
  assert.equal(slugify('Jimi Cohen'), 'jimi-cohen')
  assert.equal(slugify('  Ñandú / Tëst!! '), 'nandu-test')
  assert.equal(slugify(undefined), '')
  assert.equal(slugify('!!!'), '')
  assert.equal(slugify('a'.repeat(100)).length, 40)
})

test('download filename sorts by time and never collides on the same second', () => {
  const at = new Date('2026-11-07T14:30:12.000Z')
  assert.equal(utcStamp(at), '20261107-143012')
  const a = buildGwrDownloadFilename({
    uploadedAt: at,
    uploaderName: 'Jimi',
    uniqueId: '3f9a2c7e-1111-4222-8333-944455556666',
    extension: 'mp4',
  })
  const b = buildGwrDownloadFilename({
    uploadedAt: at,
    uploaderName: 'Jimi',
    uniqueId: 'b7d1e0f2-1111-4222-8333-944455556666',
    extension: 'mp4',
  })
  assert.equal(a, 'treegens-gwr-20261107-143012-jimi-3f9a2c.mp4')
  assert.notEqual(a, b)
})

test('download filename works without an uploader name', () => {
  const f = buildGwrDownloadFilename({
    uploadedAt: new Date('2026-11-07T00:00:00.000Z'),
    uniqueId: 'abcdef123456',
    extension: 'mov',
  })
  assert.equal(f, 'treegens-gwr-20261107-000000-abcdef.mov')
})

test('csv cells are escaped so a note with commas cannot break a row', () => {
  assert.equal(csvCell('plain'), 'plain')
  assert.equal(csvCell('a, b'), '"a, b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell(null), '')
  assert.equal(csvCell(12.5), '12.5')
})

test('manifest has a header row and one line per clip', () => {
  const csv = buildGwrManifestCsv([
    {
      downloadFilename: 'treegens-gwr-20261107-143012-jimi-3f9a2c.mp4',
      publicUrl: 'https://storage.googleapis.com/b/gwr/x.mp4',
      uploadedAt: new Date('2026-11-07T14:30:12.000Z'),
      uploaderName: 'Jimi',
      latitude: -4.05,
      longitude: 39.66,
      accuracyMeters: 8,
      reverseGeocode: 'Mombasa, Kenya',
      sizeBytes: 1024,
      note: 'row 3, tree 12',
    },
  ])
  const lines = csv.trimEnd().split('\r\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^filename,uploaded_at_utc,uploader/)
  assert.equal(
    lines[1],
    'treegens-gwr-20261107-143012-jimi-3f9a2c.mp4,2026-11-07T14:30:12.000Z,Jimi,-4.05,39.66,8,"Mombasa, Kenya",1024,"row 3, tree 12",https://storage.googleapis.com/b/gwr/x.mp4',
  )
})
