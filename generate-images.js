const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const rootDir = __dirname;

// Configuration for image generation
const CONFIG = {
  favicon: {
    sizes: [16, 32, 192, 512],
    appleTouchIcon: 180,
  },
  ogImage: {
    width: 1200,
    height: 630,
  },
};

async function generateImages() {
  console.log('Generating PNG images from SVG sources...\n');

  // Read SVG files
  const faviconSvg = fs.readFileSync(path.join(rootDir, 'favicon.svg'));
  const ogImageSvg = fs.readFileSync(path.join(rootDir, 'og-image.svg'));

  // Generate favicon PNGs from config
  const faviconSizes = [
    ...CONFIG.favicon.sizes.map(size => ({ name: `favicon-${size}x${size}.png`, size })),
    { name: 'apple-touch-icon.png', size: CONFIG.favicon.appleTouchIcon },
  ];

  for (const { name, size } of faviconSizes) {
    await sharp(faviconSvg)
      .resize(size, size)
      .png()
      .toFile(path.join(rootDir, name));
    console.log(`Created: ${name} (${size}x${size})`);
  }

  // Generate og-image.png
  await sharp(ogImageSvg)
    .resize(CONFIG.ogImage.width, CONFIG.ogImage.height)
    .png()
    .toFile(path.join(rootDir, 'og-image.png'));
  console.log(`Created: og-image.png (${CONFIG.ogImage.width}x${CONFIG.ogImage.height})`);

  console.log('\nAll images generated successfully!');
}

generateImages().catch(console.error);
