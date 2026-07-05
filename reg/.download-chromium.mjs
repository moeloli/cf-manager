import { launch } from 'cloakbrowser';

async function downloadChromium() {
  console.log('[Download] Starting Chromium download...');
  try {
    const browser = await launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log('[Download] Chromium downloaded successfully!');
    await browser.close();
    process.exit(0);
  } catch (error) {
    console.error('[Download] Failed to pre-download Chromium:', error.message);
    console.log('[Download] Chromium will be downloaded on first use instead.');
    process.exit(0);
  }
}

downloadChromium();
