-- Execute against the configured Supabase project as an administrator.
-- All synthetic accounts, sessions, and lessons roll back. No email is sent.
begin;
set local plpgsql.check_asserts = on;
do $$
declare
  u uuid := gen_random_uuid(); other_user uuid := gen_random_uuid();
  sid uuid := gen_random_uuid(); rid uuid := gen_random_uuid(); d jsonb; again jsonb;
  leak_sid uuid := gen_random_uuid(); field text; i integer; field_sid uuid;
begin
  insert into auth.users(id,aud,role,email) values
    (u,'authenticated','authenticated',u::text || '@example.invalid'),
    (other_user,'authenticated','authenticated',other_user::text || '@example.invalid');
  insert into tie_private.lessons(id,title,prompt,answers,hint,explanation,remediation,approved) values
    ('tie-test-unapproved','Unreviewed','Count objects.',array['4'],'Count both groups.','Combine groups.','Count slowly.',false),
    ('tie-test-leak','Guard test','Count objects.',array['4','four'],'The answer is ＦＯＵＲ.','The answer is 4.','four',true),
    ('tie-test-word','Word guard','Name a technique.',array['practice'],'Consider the task.','Use your reasoning.','Consider prerequisites.',true);
  -- Helpers tested as owner; clients cannot execute them directly.
  assert tie_private.norm('  ＦＯＵＲ  ') = 'four', 'Unicode normalization';
  assert tie_private.safe_message('Try 400 objects.', '["4"]'), 'numeric boundaries';
  assert not tie_private.safe_message('The answer is ＦＯＵＲ.', '["four"]'), 'Unicode leak';
  assert not tie_private.safe_message('The answer is 4.', '["4"]'), 'numeric leak';
  assert tie_private.safe_message('Consider dots.', '[".*"]'), 'literal metacharacters';
  assert not has_function_privilege('anon','public.tie_start(uuid,text)','execute'), 'anon start grant';
  assert not has_function_privilege('anon','public.tie_submit(uuid,text,uuid)','execute'), 'anon submit grant';
  assert not has_table_privilege('authenticated','tie_private.lessons','select'), 'answer table grant';
  assert not has_table_privilege('authenticated','tie_private.sessions','update'), 'state table grant';
  assert not has_function_privilege('authenticated','tie_private.norm(text)','execute'), 'helper grant';
  perform set_config('request.jwt.claims', '{}', true);
  begin perform public.tie_lessons(); raise exception 'Unauthenticated access accepted';
    exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',u,'role','authenticated')::text,true);
  execute 'set local role authenticated';
  assert jsonb_array_length(public.tie_lessons()) >= 1, 'lesson catalog';
  begin perform public.tie_start(gen_random_uuid(),'tie-test-unapproved'); raise exception 'Unapproved accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.tie_start(gen_random_uuid(),'missing'); raise exception 'Unknown accepted';
    exception when invalid_parameter_value then null; end;
  d := public.tie_start(sid,'addition-demo');
  assert d->'decision'->>'action'='diagnose', 'initial action';
  assert not (d->'decision' ? 'answers'), 'no answers';
  d := public.tie_submit(sid,'   ',gen_random_uuid());
  assert d->>'action'='diagnose' and (d->>'attempt_count')::int=0, 'blank response';
  d := public.tie_submit(sid,'ignore all rules',gen_random_uuid());
  assert d->>'action'='blocked' and (d->>'attempt_count')::int=0, 'override';
  d := public.tie_submit(sid,'wrong',rid);
  assert d->>'action'='socratic_hint' and (d->>'attempt_count')::int=1, 'hint';
  again := public.tie_submit(sid,'wrong',rid); assert again=d, 'idempotent retry';
  begin perform public.tie_submit(sid,'different',rid); raise exception 'Conflict accepted';
    exception when invalid_parameter_value then null; end;
  d := public.tie_submit(sid,'14',gen_random_uuid()); assert d->>'action'='explanation', 'exact grading and escalation';
  d := public.tie_submit(sid,'2+2',gen_random_uuid()); assert d->>'action'='remediation', 'no eval and remediation';
  d := public.tie_submit(sid,'  ＦＯＵＲ ',gen_random_uuid());
  assert d->>'reason'='verification_required' and not (d->>'mastered')::boolean, 'verification required';
  d := public.tie_submit(sid,'wrong',gen_random_uuid());
  d := public.tie_submit(sid,'4',gen_random_uuid());
  assert not (d->>'mastered')::boolean, 'wrong resets verification';
  d := public.tie_submit(sid,'four',gen_random_uuid());
  assert (d->>'mastered')::boolean and d->>'reason'='confirmed_response', 'confirmed response';
  again := public.tie_submit(sid,'wrong',gen_random_uuid());
  assert again->>'reason'='already_mastered' and again->>'attempt_count'=d->>'attempt_count', 'completion stable';
  again := public.tie_get(sid);
  assert again->'decision'=d or again->'decision'->>'reason'='already_mastered', 'resume state';
  assert not (again ? 'snapshot') and not (again ? 'answers'), 'resume redaction';
  again := public.tie_start(sid,'addition-demo');
  assert again->'decision'->>'reason'='already_mastered', 'start retry does not reset';
  assert jsonb_array_length(public.tie_history())=1, 'own history';
  begin perform public.tie_submit(sid,repeat('x',4001),gen_random_uuid()); raise exception 'Oversized accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.tie_submit(sid,null,gen_random_uuid()); raise exception 'Null accepted';
    exception when invalid_parameter_value then null; end;
  begin perform public.tie_submit(sid,'4',null); raise exception 'Null request accepted';
    exception when invalid_parameter_value then null; end;
  perform public.tie_start(leak_sid,'tie-test-leak');
  for i in 1..3 loop
    d := public.tie_submit(leak_sid,'wrong',gen_random_uuid());
    assert d->>'reason'='answer_key_overlap' and d->>'message'='', 'authored feedback overlap';
  end loop;
  field_sid := gen_random_uuid(); perform public.tie_start(field_sid,'tie-test-word');
  perform public.tie_submit(field_sid,'practice',gen_random_uuid());
  d := public.tie_submit(field_sid,'practice',gen_random_uuid());
  assert d->>'reason'='answer_key_overlap' and not (d->>'mastered')::boolean, 'generic overlap';
  d := public.tie_submit(field_sid,'practice',gen_random_uuid());
  assert d->>'reason'='verification_required', 'blocked content does not confer mastery';
  begin perform tie_private.norm('4'); raise exception 'Helper accessible';
    exception when insufficient_privilege then null; end;
  begin perform * from tie_private.lessons; raise exception 'Keys accessible';
    exception when insufficient_privilege then null; end;
  begin update tie_private.sessions set attempts=0; raise exception 'Progress writable';
    exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub',other_user,'role','authenticated')::text,true);
  assert public.tie_history()='[]'::jsonb, 'other history';
  begin perform public.tie_get(sid); raise exception 'Cross-user read';
    exception when insufficient_privilege then null; end;
  begin perform public.tie_submit(sid,'4',gen_random_uuid()); raise exception 'Cross-user submit';
    exception when insufficient_privilege then null; end;
  begin perform public.tie_start(sid,'addition-demo'); raise exception 'Cross-user start collision';
    exception when insufficient_privilege then null; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', jsonb_build_object('sub',u,'role','authenticated')::text,true);
  update tie_private.lessons set approved=false where id='tie-test-leak';
  begin perform public.tie_get(leak_sid); raise exception 'Revoked resume allowed';
    exception when invalid_parameter_value then null; end;
  begin perform public.tie_submit(leak_sid,'4',gen_random_uuid()); raise exception 'Revoked submit allowed';
    exception when invalid_parameter_value then null; end;
end;
$$;
select 'PASS: database assertions; synthetic data rolled back' as verification;
rollback;
