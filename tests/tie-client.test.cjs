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
