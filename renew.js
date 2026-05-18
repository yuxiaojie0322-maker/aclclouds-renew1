const { chromium } = require('playwright');
const https = require('https');

const EMAIL = process.env.ACL_EMAIL;
const PASSWORD = process.env.ACL_PASSWORD;
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const BASE_URL = 'https://dash.aclclouds.com';

// Send Telegram notification
async function notify(message, photoPath) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  
  if (photoPath) {
    // Send photo with caption
    const fs = require('fs');
    const FormData = require('form-data') || null;
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const fileData = fs.readFileSync(photoPath);
    
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${TG_CHAT_ID}\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${message}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="error.png"\r\nContent-Type: image/png\r\n\r\n` + fileData.toString('binary') + `\r\n--${boundary}--\r\n`;
    
    return new Promise((resolve, reject) => {
      const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { console.log('[TG] Photo sent'); resolve(data); });
      });
      req.on('error', reject);
      req.write(body, 'binary');
      req.end();
    });
  }
  
  const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML' });
  return new Promise((resolve, reject) => {
    const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { console.log('[TG] Notification sent'); resolve(data); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log('=== ACLClouds Auto-Renew ===');
  console.log(`Time: ${new Date().toISOString()}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // Step 1: Go to login page
    console.log('[1] Loading login page...');
    await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'networkidle' });

    // Step 2: Fill credentials
    console.log('[2] Filling credentials...');
    await page.fill('#username', EMAIL);
    await page.fill('#password', PASSWORD);

    // Step 3: Click the custom captcha checkbox
    console.log('[3] Solving captcha...');
    const captcha = page.locator('.auth-captcha-inner').first();
    
    const box = await captcha.boundingBox();
    if (box) {
      await page.mouse.move(box.x - 50, box.y - 30);
      await page.waitForTimeout(300);
      await page.mouse.move(box.x + 10, box.y + 10);
      await page.waitForTimeout(200);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(150);
    }
    
    await captcha.click();
    await page.waitForTimeout(3000);
    
    const verified = await page.locator('.auth-captcha-box.verified').count();
    if (verified === 0) {
      console.log('[3b] Retrying captcha...');
      await captcha.click();
      await page.waitForTimeout(3000);
    }
    
    const finalCheck = await page.locator('.auth-captcha-box.verified').count();
    console.log(`  Captcha verified: ${finalCheck > 0}`);

    // Step 4: Click sign in
    console.log('[4] Signing in...');
    await page.click('button:has-text("Sign in")');
    
    // Wait for response - check multiple outcomes
    try {
      // Wait for either navigation or error message
      await Promise.race([
        page.waitForURL('**/', { timeout: 20000 }),
        page.waitForSelector('.error, .alert-danger, [class*="error"], [class*="toast"]', { timeout: 20000 })
      ]);
    } catch (e) {
      // Timeout - let's check what happened
    }
    
    // Check current URL
    const currentUrl = page.url();
    console.log(`  Current URL: ${currentUrl}`);
    
    // Check for any visible error/alert text
    const pageText = await page.textContent('body');
    const hasError = pageText.match(/error|invalid|incorrect|failed|wrong|captcha|blocked/i);
    
    if (currentUrl.includes('/auth/login')) {
      // Still on login page - something went wrong
      const screenshotPath = '/tmp/acl_login_error.png';
      await page.screenshot({ path: screenshotPath, fullPage: true });
      
      // Get any error messages
      const errorElements = await page.locator('.error, .alert, [class*="error"], [class*="toast"], .auth-error, p[class*="error"]').allTextContents();
      const errorMsg = errorElements.filter(t => t.trim()).join(' | ') || 'No error message found';
      
      console.log(`  Error: ${errorMsg}`);
      console.log(`  Page text snippet: ${pageText.substring(0, 500)}`);
      
      await notify(`❌ ACLClouds Login Failed\nURL: ${currentUrl}\nError: ${errorMsg}`, screenshotPath);
      throw new Error(`Login failed - still on login page. Error: ${errorMsg}`);
    }
    
    await page.waitForTimeout(2000);
    console.log('[OK] Logged in!');

    // Step 5: Get server list via API
    console.log('[5] Fetching servers...');
    const serversResp = await page.evaluate(async () => {
      const r = await fetch('/api/client');
      return r.json();
    });

    if (serversResp.errors) {
      console.error('[FAIL] API error:', JSON.stringify(serversResp.errors));
      await notify(`❌ ACLClouds Renew Failed\nAPI Error: ${JSON.stringify(serversResp.errors)}`);
      process.exit(1);
    }

    const servers = serversResp.data;
    console.log(`[5] Found ${servers.length} server(s)`);

    // Step 6: Renew each server
    let results = [];
    for (const server of servers) {
      const { uuid, name, can_renew, expires_at } = server.attributes;
      console.log(`\n--- Server: ${name} (${uuid}) ---`);
      console.log(`  Expires: ${expires_at}`);
      console.log(`  Can renew: ${can_renew}`);

      if (can_renew) {
        console.log('  [RENEWING]...');
        const renewResp = await page.evaluate(async (uuid) => {
          const r = await fetch(`/api/client/servers/${uuid}/upgrade/renew`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          return r.json();
        }, uuid);

        console.log('  Response:', JSON.stringify(renewResp));

        if (renewResp.error) {
          results.push(`⚠️ ${name}: ${renewResp.error}`);
        } else if (renewResp.requires_payment) {
          results.push(`💰 ${name}: Requires payment`);
        } else {
          results.push(`✅ ${name}: Renewed!`);
        }
      } else {
        console.log(`  ⏳ Not available yet`);
        results.push(`⏳ ${name}: Not available yet (expires: ${expires_at})`);
      }
    }

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const msg = `☁️ <b>ACLClouds Auto-Renew</b>\n⏰ ${now}\n\n${results.join('\n')}`;
    await notify(msg);

    console.log('\n=== Summary ===');
    results.forEach(r => console.log(r));
    console.log('\n=== Done ===');

  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
