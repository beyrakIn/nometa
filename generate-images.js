const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const rootDir = __dirname;

async function generateImages() {
  console.log('Generating PNG images from SVG sources...\n');

  // Read SVG files
  const faviconSvg = fs.readFileSync(path.join(rootDir, 'favicon.svg'));
  const ogImageSvg = fs.readFileSync(path.join(rootDir, 'og-image.svg'));

  // Generate favicon PNGs
  const faviconSizes = [
    { name: 'favicon-16x16.png', size: 16 },
    { name: 'favicon-32x32.png', size: 32 },
    { name: 'favicon-192x192.png', size: 192 },
    { name: 'favicon-512x512.png', size: 512 },
    { name: 'apple-touch-icon.png', size: 180 },
  ];

  for (const { name, size } of faviconSizes) {
    await sharp(faviconSvg)
      .resize(size, size)
      .png()
      .toFile(path.join(rootDir, name));
    console.log(`Created: ${name} (${size}x${size})`);
  }

  // Generate og-image.png (1200x630)
  await sharp(ogImageSvg)
    .resize(1200, 630)
    .png()
    .toFile(path.join(rootDir, 'og-image.png'));
  console.log('Created: og-image.png (1200x630)');

  console.log('\nAll images generated successfully!');
}

generateImages().catch(console.error);
