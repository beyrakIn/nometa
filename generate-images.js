const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
const imagesDir = path.join(rootDir, 'assets', 'images');

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
  const faviconSvg = fs.readFileSync(path.join(imagesDir, 'favicon.svg'));
  const ogImageSvg = fs.readFileSync(path.join(imagesDir, 'og-image.svg'));

  // Generate favicon PNGs from config
  const faviconSizes = [
    ...CONFIG.favicon.sizes.map(size => ({ name: `favicon-${size}x${size}.png`, size })),
    { name: 'apple-touch-icon.png', size: CONFIG.favicon.appleTouchIcon },
  ];

  for (const { name, size } of faviconSizes) {
    await sharp(faviconSvg)
      .resize(size, size)
      .png()
      .toFile(path.join(imagesDir, name));
    console.log(`Created: assets/images/${name} (${size}x${size})`);
  }

  // Generate og-image.png
  await sharp(ogImageSvg)
    .resize(CONFIG.ogImage.width, CONFIG.ogImage.height)
    .png()
    .toFile(path.join(imagesDir, 'og-image.png'));
  console.log(`Created: assets/images/og-image.png (${CONFIG.ogImage.width}x${CONFIG.ogImage.height})`);

  // Generate favicon.ico in root directory (multi-size: 16, 32, 48)
  const icoSizes = [16, 32, 48];
  const tempPngPaths = [];
  for (const size of icoSizes) {
    const tempPath = path.join(rootDir, `temp-favicon-${size}.png`);
    await sharp(faviconSvg).resize(size, size).png().toFile(tempPath);
    tempPngPaths.push(tempPath);
  }
  const pngToIco = (await import('png-to-ico')).default;
  const icoBuffer = await pngToIco(tempPngPaths);
  fs.writeFileSync(path.join(rootDir, 'favicon.ico'), icoBuffer);
  // Clean up temp files
  tempPngPaths.forEach(p => fs.unlinkSync(p));
  console.log(`Created: favicon.ico (${icoSizes.join(', ')} multi-size)`);

  console.log('\nAll images generated successfully!');
}

generateImages().catch(console.error);
