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

    const compressed = await sharp(file.buffer)
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

module.exports = { compressFile, compressFiles };
