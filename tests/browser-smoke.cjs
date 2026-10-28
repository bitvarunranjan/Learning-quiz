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
  let attempts=0,failOnce=true,submitted=[],signupReturn=null; const bankStates={};
  const bankLessons=[{id:'bank-m1',title:'Mathematics · m1',question_id:'m1',subject:'Mathematics',topic:'Quadratics'},{id:'bank-m2',title:'Mathematics · m2',question_id:'m2',subject:'Mathematics',topic:'Quadratics'}];
  const sid='5d8df718-fb1b-4a3d-8e96-570a8bc23ae6';
  const initial={action:'diagnose',message:'What is two plus two?',reason:'initial_diagnosis',attempt_count:0,mastered:false};let latest=initial;
  await page.route('https://oxsztvxpwuwlkowlgtwk.supabase.co/**',async route=>{
   const url=route.request().url(),body=route.request().postDataJSON();let data;
   if(url.includes('/auth/v1/signup')){signupReturn=new URL(url).searchParams.get('redirect_to');data={user:{id:'mock-user'}};}
   else if(url.includes('/auth/v1/resend'))data={};
   else if(url.includes('/auth/v1/token')&&body.password==='wrong-password'){await route.fulfill({status:400,json:{error_code:'invalid_credentials',msg:'private error detail'}});return;}
   else if(url.includes('/auth/v1/token'))data={access_token:'mock-token',refresh_token:'mock-refresh',expires_at:Date.now()/1000+3600,user:{id:'mock-user'}};
   else if(url.endsWith('/tie_catalog'))data={lessons:[{id:'addition-demo',title:'Combining groups'},...bankLessons],quizzes:[{id:'quiz-math',title:'Quadratic Equations Practice',question_count:2}],can_publish:false};
   else if(url.endsWith('/tie_quiz_questions'))data=bankLessons;
   else if(url.endsWith('/tie_lessons'))data=[{id:'addition-demo',title:'Combining groups'}];
   else if(url.endsWith('/tie_history'))data=[...(attempts?[{session_id:sid,lesson_id:'addition-demo',attempt_count:attempts,mastered:latest.mastered}]:[]),...Object.entries(bankStates).map(([id,v])=>({session_id:id,lesson_id:v.lesson,attempt_count:v.attempts,mastered:v.mastered}))];
   else if(url.endsWith('/tie_start')&&body.p_lesson_id.startsWith('bank-')){
    const first=body.p_lesson_id==='bank-m1';const id=body.p_session_id;
    bankStates[id]={lesson:body.p_lesson_id,attempts:0,pending:false,mastered:false,correct:first?'2 and 3':'0'};
    data={session_id:id,lesson_id:body.p_lesson_id,prompt:first?'What are the roots of x² − 5x + 6 = 0?':'For x² − 9 = 0, what is the sum of the roots?',options:first?['1 and 6','2 and 3','−2 and −3','−1 and −6']:['−9','0','3','9'],decision:initial};
   }
   else if(url.endsWith('/tie_start'))data={session_id:sid,decision:initial};
   else if(url.endsWith('/tie_get'))data={session_id:sid,prompt:initial.message,decision:latest};
   else if(url.endsWith('/tie_submit')&&bankStates[body.p_session_id]){
    const v=bankStates[body.p_session_id];v.attempts++;const correct=body.p_response===v.correct;
    v.mastered=correct&&v.pending;v.pending=correct;
    data={action:correct?'verification':'socratic_hint',message:v.mastered?'Practice complete.':correct?'Check your reasoning.':'Compare the given coefficients.',attempt_count:v.attempts,mastered:v.mastered};
   }
   else if(url.endsWith('/tie_submit')){
    submitted.push(body);if(failOnce){failOnce=false;await route.abort('failed');return;}attempts++;
    latest=attempts===1?{action:'socratic_hint',message:'Count both groups.',reason:'first_error',attempt_count:1,mastered:false}:{action:'verification',message:attempts===3?'Practice complete.':'Check your reasoning.',reason:'verified',attempt_count:attempts,mastered:attempts===3};data=latest;
   }else if(url.includes('/logout')){await route.fulfill({status:204});return;}else throw new Error('Unexpected request '+url);
   await route.fulfill({json:data});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/#access_token=callback-secret&refresh_token=callback-refresh&type=signup`);
  assert.equal(new URL(page.url()).hash,'');
  await page.getByText('Confirmation link opened. Sign in to continue.',{exact:true}).waitFor();
  if(await page.locator('#tieCloud').getAttribute('open')===null)await page.locator('#tieCloud summary').click();
  await page.locator('#tieEmail').fill('test@example.invalid');await page.locator('#tiePassword').fill('mock-password');
  await page.locator('#tieSignup').click();await page.getByText('Check your email to confirm your account, then sign in here.',{exact:true}).waitFor();
  assert.equal(signupReturn,`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#tiePassword').fill('wrong-password');await page.locator('#tieAuth button[type=submit]').click();
  await page.getByText('Email or password is incorrect.',{exact:true}).waitFor();
  await page.locator('#tieResend').click();
  await page.getByText('If an account needs confirmation, a new link has been requested. Check your email.',{exact:true}).waitFor();
  await page.locator('#tiePassword').fill('mock-password');
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
  await page.locator('#tiePassword').fill('mock-password');await page.locator('#tieAuth button[type=submit]').click();
  await page.getByText('Choose a lesson or resume a session.',{exact:true}).waitFor();
  assert.equal(await page.locator('#tiePublish').isVisible(),false);
  await page.locator('#tieQuiz').selectOption('quiz-math');await page.getByText('Practice set selected. Choose a question to start.',{exact:true}).waitFor();
  await page.locator('#tieStart').click();await page.getByText('Lesson started.',{exact:true}).waitFor();
  assert.equal(await page.locator('#tieResponse').isVisible(),false);
  await page.locator('#tieResponseForm button[type=submit]').click();await page.getByText('Choose an option before submitting.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'A. 1 and 6',exact:true}).click();await page.locator('#tieResponseForm button[type=submit]').click();
  await page.getByText(/^socratic hint:.*1 attempts/).waitFor();
  await page.getByRole('button',{name:'B. 2 and 3',exact:true}).click();
  await page.locator('#tieResponseForm button[type=submit]').click();await page.getByText(/^verification: Check your reasoning.*2 attempts/).waitFor();
  await page.locator('#tieResponseForm button[type=submit]').click();await page.getByText(/^verification: Practice complete.*3 attempts/).waitFor();
  await page.locator('#tieNext').click();await page.getByRole('heading',{name:'For x² − 9 = 0, what is the sum of the roots?',exact:true}).waitFor();
  await page.getByRole('button',{name:'B. 0',exact:true}).click();await page.locator('#tieResponseForm button[type=submit]').click();
  await page.getByText(/^verification: Check your reasoning.*1 attempts/).waitFor();
  await page.locator('#tieResponseForm button[type=submit]').click();await page.getByText(/^verification: Practice complete.*2 attempts/).waitFor();
  assert.equal(await page.locator('#tieNext').isVisible(),false);
  await page.locator('#tieSignout').click();await page.getByText('Signed out of Cloud Tutor.',{exact:true}).waitFor();
  await page.locator('#tieCloud summary').click();await page.locator('#loginName').fill('Offline Tester');
  await page.getByRole('button',{name:'Continue to dashboard →',exact:true}).click();await page.getByRole('button',{name:'My Quizzes',exact:true}).click();
  await page.getByRole('button',{name:'Start practice',exact:true}).first().click();await page.locator('#attemptHost .option').first().click();
  await page.getByRole('button',{name:'Submit now',exact:true}).click();await page.getByRole('heading',{name:/Result:/}).waitFor();
  assert.deepEqual(errors,[]);await page.setViewportSize({width:390,height:844});await page.locator('#tieCloud summary').click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  if(process.env.SCREENSHOT_PATH)await page.screenshot({path:process.env.SCREENSHOT_PATH,fullPage:true});
  console.log('PASS: browser signup redirect, callback cleanup, safe invalid-login feedback, sign-in, start, retry, verification, resume, sign-out, token storage, bank catalog, quiz selection, MCQ validation/grading, next-question navigation, publisher visibility, offline quiz regression, mobile layout; no uncaught page errors.');
 }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
