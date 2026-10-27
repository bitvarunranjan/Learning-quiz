// Development-only Playwright test. Cloud responses are mocked; no email is sent.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_DIR || 'playwright');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
(async () => {
 const server=http.createServer((req,res)=>{
  const name=req.url==='/'?'index.html':req.url.slice(1).split('?')[0];
  if(!['index.html','tie-config.js','tie-client.js','tie-ui.js'].includes(name)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(path.join(root,name)));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r)); let browser;
 try {
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1100,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let attempts=0,failOnce=true,submitted=[];
  const sid='5d8df718-fb1b-4a3d-8e96-570a8bc23ae6';
  const initial={action:'diagnose',message:'What is two plus two?',reason:'initial_diagnosis',attempt_count:0,mastered:false};let latest=initial;
  await page.route('https://oxsztvxpwuwlkowlgtwk.supabase.co/**',async route=>{
   const url=route.request().url(),body=route.request().postDataJSON();let data;
   if(url.includes('/auth/v1/token'))data={access_token:'mock-token',refresh_token:'mock-refresh',expires_at:Date.now()/1000+3600,user:{id:'mock-user'}};
   else if(url.endsWith('/tie_lessons'))data=[{id:'addition-demo',title:'Combining groups'}];
   else if(url.endsWith('/tie_history'))data=attempts?[{session_id:sid,lesson_id:'addition-demo',attempt_count:attempts,mastered:latest.mastered}]:[];
   else if(url.endsWith('/tie_start'))data={session_id:sid,decision:initial};
   else if(url.endsWith('/tie_get'))data={session_id:sid,prompt:initial.message,decision:latest};
   else if(url.endsWith('/tie_submit')){
    submitted.push(body);if(failOnce){failOnce=false;await route.abort('failed');return;}attempts++;
    latest=attempts===1?{action:'socratic_hint',message:'Count both groups.',reason:'first_error',attempt_count:1,mastered:false}:{action:'verification',message:attempts===3?'Practice complete.':'Check your reasoning.',reason:'verified',attempt_count:attempts,mastered:attempts===3};data=latest;
   }else if(url.includes('/logout')){await route.fulfill({status:204});return;}else throw new Error('Unexpected request '+url);
   await route.fulfill({json:data});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#tieCloud summary').click();
  await page.locator('#tieEmail').fill('test@example.invalid');await page.locator('#tiePassword').fill('mock-password');
  await page.locator('#tieAuth button[type=submit]').click();await page.getByText('Choose a lesson or resume a session.',{exact:true}).waitFor();
  assert.equal(await page.locator('#tiePassword').inputValue(),'');
  await page.locator('#tieStart').click();await page.getByText('Lesson started.',{exact:true}).waitFor();
  await page.locator('#tieResponse').fill('<img src=x onerror=alert(1)>');await page.locator('#tieResponseForm button').click();
  await page.getByText(/Connection interrupted/).waitFor();
  await page.locator('#tieResponse').fill('edited while retrying');await page.locator('#tieResponseForm button').click();
  await page.getByText('Response saved.',{exact:true}).waitFor();assert.deepEqual(submitted[0],submitted[1]);
  for(let i=0;i<2;i++){
   await page.locator('#tieResponse').fill('4');await page.locator('#tieResponseForm button').click();
   await page.getByText(i===0?'Response saved.':'Practice complete. Repeated correctness is a practice signal.',{exact:true}).waitFor();
  }
  assert.equal(await page.locator('#tieResponseForm').isVisible(),false);
  await page.locator('#tieHistory button').first().click();await page.getByText('Session resumed.',{exact:true}).waitFor();
  assert.match(await page.locator('#tieDecision').innerText(),/verification: Practice complete/);
  const storage=await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}));assert.ok(!storage.includes('mock-token')&&!storage.includes('mock-refresh'));
  await page.locator('#tieSignout').click();await page.getByText('Signed out of Cloud Tutor.',{exact:true}).waitFor();assert.equal(await page.locator('#tieAuth').isVisible(),true);
  await page.locator('#tieCloud summary').click();await page.locator('#loginName').fill('Offline Tester');
  await page.getByRole('button',{name:'Continue to dashboard →',exact:true}).click();await page.getByRole('button',{name:'My Quizzes',exact:true}).click();
  await page.getByRole('button',{name:'Start practice',exact:true}).first().click();await page.locator('#attemptHost .option').first().click();
  await page.getByRole('button',{name:'Submit now',exact:true}).click();await page.getByRole('heading',{name:/Result:/}).waitFor();
  assert.deepEqual(errors,[]);await page.setViewportSize({width:390,height:844});await page.locator('#tieCloud summary').click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
  console.log('PASS: browser sign-in, start, retry, verification, resume, sign-out, token storage, offline quiz regression, mobile layout; no uncaught page errors.');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
