const sharp = require('sharp');
const path = require('path');

const COMPRESSIBLE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/heic',
  'image/heif'
];

const JPEG_QUALITY = 80;
const MAX_WIDTH = 2000;

/**
 * Compress a single multer file object.
 * Returns a new object with compressed buffer, updated size/mimetype/originalname.
 * Falls back to original file on any error.
 */
async function compressFile(file) {
  if (!COMPRESSIBLE_TYPES.includes(file.mimetype.toLowerCase())) {
    return file;
  }

  try {
    const originalSize = file.size;

    // limitInputPixels caps the decoded pixel count (H2): a KB-sized crafted
    // image can otherwise decode to 1GB+ RGBA and OOM the box. 24MP covers any
    // legitimate phone photo. failOn:'error' rejects truncated/malformed data.
    const compressed = await sharp(file.buffer, { limitInputPixels: 24_000_000, failOn: 'error' })
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .rotate() // auto-rotate based on EXIF
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();

    const compressedSize = compressed.length;
    const savings = Math.round((1 - compressedSize / originalSize) * 100);

    // Only use compressed version if it's actually smaller
    if (compressedSize >= originalSize) {
      console.log(`[Compress] ${file.originalname}: ${formatSize(originalSize)} — skipped (compression would increase size)`);
      return file;
    }

    // Update extension if format changed (PNG/HEIC → JPEG)
    let newName = file.originalname;
    const ext = path.extname(newName).toLowerCase();
    if (ext !== '.jpg' && ext !== '.jpeg') {
      newName = newName.replace(/\.[^.]+$/, '.jpg');
    }

    console.log(`[Compress] ${file.originalname}: ${formatSize(originalSize)} → ${formatSize(compressedSize)} (${savings}% reduction)`);

    return {
      ...file,
      buffer: compressed,
      size: compressedSize,
      originalSize: originalSize,
      mimetype: 'image/jpeg',
      originalname: newName
    };
  } catch (err) {
    console.error(`[Compress] Failed for ${file.originalname}: ${err.message} — using original`);
    return file;
  }
}

/**
 * Compress an array of multer file objects.
 */
async function compressFiles(files) {
  return Promise.all(files.map(compressFile));
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
}

/**
 * Detect a file's MIME type from its leading magic bytes.
 * Used to set the storage contentType from actual content rather than the
 * client-declared mimetype (which a caller can spoof to smuggle SVG/HTML and
 * get stored XSS when the file is later served). Returns null for unknown
 * content so the caller can fall back to application/octet-stream (download).
 */
function detectMimeFromMagic(buffer) {
  if (!buffer || buffer.length < 4) return null;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  // HEIC/HEIF: 'ftyp' box at offset 4 with a heic/heif/mif1 brand.
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (['heic', 'heix', 'heif', 'mif1', 'hevc'].includes(brand)) return 'image/heic';
  }
  return null;
}

module.exports = { compressFile, compressFiles, detectMimeFromMagic };
