const {test} = require('node:test');
const assert = require('node:assert/strict');
const {TieClient} = require('../tie-client.js');
const key = 'sb_publishable_test';
const auth = () => ({access_token:'user-token', refresh_token:'refresh-token', expires_at:Date.now()/1000+3600});
const response = data => ({ok:true,status:200,json:async()=>data});

test('requires HTTPS origin and a public key', () => {
  for (const url of ['http://a.com','https://a.com/path','https://a.com?x=1','https://u@a.com']) {
    assert.throws(()=>new TieClient(url,key));
  }
  for(const value of ['sb_secret_x', '', 'not-a-key']) assert.throws(()=>new TieClient('https://a.com',value));
});
test('RPC refuses calls before authentication', async () => {
  const c = new TieClient('https://a.com',key,()=>{throw new Error('network should not run')});
  await assert.rejects(c.rpc('tie_lessons'),/sign in/);
});
test('password sign-in then authenticated RPC; body is exact', async () => {
  const calls=[];
  const c=new TieClient('https://a.com',key, async(...args)=>{calls.push(args);return response(calls.length===1?{...auth(),user:{id:'u'}}:{action:'socratic_hint'});});
  await c.signIn('u@example.com','password');
  const body={p_session_id:'s',p_request_id:'r',p_response:'wrong'};
  assert.equal((await c.rpc('tie_submit',body)).action,'socratic_hint');
  assert.equal(calls[1][1].headers.Authorization,'Bearer user-token');
  assert.deepEqual(JSON.parse(calls[1][1].body),body);
  assert.equal(calls[1][0],'https://a.com/rest/v1/rpc/tie_submit');
});
test('refreshes expiring token before RPC',async()=>{
  const calls=[];
  const c=new TieClient('https://a.com',key,async(url)=>{calls.push(url);return response(calls.length===1?auth():[]);});
  c.auth={...auth(),expires_at:0};await c.rpc('tie_history');
  assert.match(calls[0],/grant_type=refresh_token/);assert.match(calls[1],/tie_history$/);
});
test('failed refresh removes authentication',async()=>{
  const c=new TieClient('https://a.com',key,async()=>({ok:false,status:401}));
  c.auth={...auth(),expires_at:0};await assert.rejects(c.rpc('tie_lessons'),/sign in again/);assert.equal(c.auth,null);
});
test('signout clears memory even when network fails',async()=>{
  const c=new TieClient('https://a.com',key,async()=>{throw new TypeError('secret');});
  c.auth=auth();await assert.rejects(c.signOut(),/Connection interrupted/);assert.equal(c.auth,null);
});
test('confirmation signup does not imply an authenticated session',async()=>{
  const c=new TieClient('https://a.com',key,async()=>response({user:{id:'u'}}));
  assert.equal(await c.signUp('u@example.com','password'),false);assert.equal(c.auth,null);
});
test('unknown RPC refused',async()=>{
  const c=new TieClient('https://a.com',key,async()=>response({}));c.auth=auth();
  await assert.rejects(c.rpc('delete_users'),/Unsupported/);
});
test('HTTP failures never echo server response or tokens',async()=>{
  const c=new TieClient('https://a.com',key,async()=>({ok:false,status:500,json:async()=>({secret:'secret'})}));c.auth=auth();
  await assert.rejects(c.rpc('tie_lessons'),/^Error: Request failed \(500\)\.$/);
});
test('RPC rejection of expired JWT clears sign-in state',async()=>{
  const c=new TieClient('https://a.com',key,async()=>({ok:false,status:401}));c.auth=auth();
  await assert.rejects(c.rpc('tie_lessons'),/sign in again/);assert.equal(c.auth,null);
});
test('wrong-password and unconfirmed-email errors have safe actionable messages',async()=>{
  for(const [code,message] of [['invalid_credentials','Email or password is incorrect.'],['email_not_confirmed','Confirm your email before signing in.']]){
    const c=new TieClient('https://a.com',key,async()=>({ok:false,status:400,json:async()=>({error_code:code,msg:'private detail'})}));
    await assert.rejects(c.signIn('u@example.com','wrong'),e=>e.message===message&&e.status===400);
  }
});
test('unknown error codes and server text are never reflected',async()=>{
  for(const code of ['__proto__','<script>secret</script>']){
    const c=new TieClient('https://a.com',key,async()=>({ok:false,status:400,json:async()=>({code,message:'private-token'})}));
    await assert.rejects(c.signIn('u@example.com','wrong'),/^Error: Request failed \(400\)\.$/);
  }
});
test('non-JSON errors and throttling keep safe fallbacks',async()=>{
  for(const [status,message] of [[500,'Request failed (500).'],[429,'Too many requests. Please wait a few minutes and try again.']]){
    const c=new TieClient('https://a.com',key,async()=>({ok:false,status,json:async()=>{throw new Error('private body')}}));
    await assert.rejects(c.signIn('u@example.com','wrong'),e=>e.message===message);
  }
});
test('signup and resend use the exact return page without query/fragment secrets',async()=>{
  const calls=[];
  const c=new TieClient('https://a.com',key,async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});return response({user:{id:'u'}});});
  await c.signUp('u@example.com','password','https://site.com/Learning-quiz/?secret=x#secret=y');
  await c.resendConfirmation('u@example.com','https://site.com/Learning-quiz/');
  for(const call of calls)assert.equal(new URL(call.url).searchParams.get('redirect_to'),'https://site.com/Learning-quiz/');
  assert.deepEqual(calls[1].body,{type:'signup',email:'u@example.com'});
});
test('confirmation redirect validation refuses unsafe schemes and embedded credentials',()=>{
  for(const url of ['javascript:alert(1)','http://public.example/','https://user:password@site.com/'])assert.throws(()=>TieClient.redirectQuery(url));
  assert.ok(TieClient.redirectQuery('http://localhost:8000/'));
});
test('confirmation returns strip credentials without accepting a URL session',()=>{
  const result=TieClient.authReturn('https://site.com/Learning-quiz/?view=tutor#access_token=secret&refresh_token=another&expires_in=3600&type=signup');
  assert.equal(result.cleanURL,'https://site.com/Learning-quiz/?view=tutor');
  assert.match(result.message,/Sign in to continue/);
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('confirmation errors are sanitized and regular anchors are untouched',()=>{
  const result=TieClient.authReturn('https://site.com/#error=access_denied&error_description=%3Cscript%3E&error_code=otp_expired');
  assert.equal(result.cleanURL,'https://site.com/');assert.match(result.message,/invalid or expired/);assert.ok(!result.message.includes('script'));
  assert.equal(TieClient.authReturn('https://site.com/#lesson'),null);
});
test('bank catalog, quiz and educator publication routes are allowed',async()=>{
  const calls=[];const c=new TieClient('https://a.com',key,async(url,opts)=>{calls.push([url,JSON.parse(opts.body)]);return response({});});c.auth=auth();
  await c.rpc('tie_catalog');await c.rpc('tie_quiz_questions',{p_quiz_id:'q'});await c.rpc('tie_publish_bank',{p_payload:{questions:[],quizzes:[]}});
  assert.deepEqual(calls.map(x=>x[0].split('/').pop()),['tie_catalog','tie_quiz_questions','tie_publish_bank']);
  assert.equal(calls[1][1].p_quiz_id,'q');
});
test('RPC permission/content errors use fixed text instead of raw server messages',async()=>{
  for(const [code,status] of [['42501',403],['22023',400],['54000',500]]){
    const c=new TieClient('https://a.com',key,async()=>({ok:false,status,json:async()=>({code,message:'private answer key'})}));c.auth=auth();
    await assert.rejects(c.rpc('tie_publish_bank'),e=>!e.message.includes('private')&&!e.message.includes('Request failed'));
  }
});
