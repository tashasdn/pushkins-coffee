begin;

create function public.nr_create_draft(p_key uuid, p_name text, p_subject text, p_description text, p_code_hash text, p_ip_hash text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare
  existing requests_app.tickets%rowtype;
  expiry timestamptz;
begin
  if p_key is null or not coalesce(p_code_hash ~ '^[0-9a-f]{64}$' and p_ip_hash ~ '^[0-9a-f]{64}$', false) then
    return jsonb_build_object('result','invalid');
  end if;
  -- Serialize both quotas and idempotency before reading and inserting.
  perform pg_advisory_xact_lock(77001, 1);
  select * into existing from requests_app.tickets where request_key = p_key;
  if found then
    if (existing.name,existing.subject,existing.description,existing.code_hash)
      is distinct from (p_name,p_subject,p_description,p_code_hash) then
      return jsonb_build_object('result','conflict');
    end if;
    if existing.expires_at <= clock_timestamp() then
      return jsonb_build_object('result','expired');
    end if;
    return jsonb_build_object('result','ok','expiresAt',existing.expires_at);
  end if;
  if (select count(*) from requests_app.tickets where ip_hash = p_ip_hash and created_at > clock_timestamp() - interval '10 minutes') >= 10
     or (select count(*) from requests_app.tickets where created_at > clock_timestamp() - interval '24 hours') >= 500 then
    return jsonb_build_object('result','limited');
  end if;
  delete from requests_app.tickets where status = 'draft' and created_at < clock_timestamp() - interval '24 hours';
  insert into requests_app.tickets(request_key,name,subject,description,code_hash,ip_hash)
  values(p_key,p_name,p_subject,p_description,p_code_hash,p_ip_hash) returning expires_at into expiry;
  return jsonb_build_object('result','ok','expiresAt',expiry);
end $$;

create function requests_app.button(label text, data text)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_object('text', label, 'callback_data', data)
$$;

create function requests_app.status_label(value text)
returns text language sql immutable set search_path = pg_catalog as $$
  select case value when 'new' then 'Новая' when 'in_progress' then 'В работе' when 'done' then 'Завершена' end
$$;

create function requests_app.card(t requests_app.tickets, admin boolean)
returns jsonb language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object(
    'text', format('Обращение №%s · %s%s%s%s%s%s%s', t.number, requests_app.status_label(t.status),
      E'\nИмя: ', t.name, E'\nТема: ', t.subject, E'\n\n', t.description),
    'reply_markup', jsonb_build_object('inline_keyboard',
      jsonb_build_array(
        jsonb_build_array(requests_app.button(case when admin then 'Ответить' else 'Написать уточнение' end,
          'p:' || t.number), requests_app.button('История', 'h:' || t.number || ':0')))
      || case when admin then jsonb_build_array(jsonb_build_array(
        requests_app.button('В работу', 'w:' || t.number), requests_app.button('Завершить', 'd:' || t.number)))
        else '[]'::jsonb end
      || jsonb_build_array(jsonb_build_array(requests_app.button('К списку',
        case when admin then 'l:n:0' else 'l:m:0' end))))
  )
$$;

create function requests_app.queue(
  uid bigint, effect text, recipient bigint, body jsonb, retry boolean default false,
  ticket bigint default null, nonce uuid default null
)
returns void language sql set search_path = pg_catalog as $$
  insert into requests_app.outbox(update_id,effect_key,chat_id,payload,retryable,prompt_ticket,prompt_nonce)
  values(uid,uid || ':' || effect,recipient,body,retry,ticket,nonce)
  on conflict(effect_key) do nothing
$$;

create function public.nr_handle_update(p_event jsonb, p_admin bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare
  uid bigint := (p_event->>'id')::bigint;
  actor bigint := (p_event->>'chat')::bigint;
  is_admin boolean := coalesce(actor = p_admin and p_admin > 0, false);
  body text := p_event->>'text';
  action text := p_event->>'action';
  ref text := p_event->>'ref';
  page_no integer := coalesce((p_event->>'page')::integer,0);
  t requests_app.tickets%rowtype;
  pr requests_app.prompts%rowtype;
  item record;
  prompt_id uuid;
  message_text text;
  keyboard jsonb := '[]'::jsonb;
  response jsonb;
  i integer := 0;
  recipient bigint;
  new_status text;
  prompt_state text;
begin
  if uid is null or actor is null or actor <= 0 or p_event->>'from' is distinct from p_event->>'chat'
      or p_event->>'private' is distinct from 'true' or p_event->>'bot' is distinct from 'false' then
    return jsonb_build_object('result','ignored');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('requests_app:telegram:' || actor,0));
  insert into requests_app.updates(id,chat_id) values(uid,actor) on conflict do nothing;
  if not found then return jsonb_build_object('result','duplicate'); end if;
  if (select count(*) from requests_app.updates where chat_id = actor and accepted
        and created_at > clock_timestamp() - interval '1 minute') > 30 then
    update requests_app.updates set accepted=false where id=uid;
    return jsonb_build_object('result','limited');
  end if;

  if action = 'id' then
    message_text := 'Ваш Telegram ID: ' || actor;
  elsif action = 'start' and ref is not null then
    select * into t from requests_app.tickets where code_hash = ref for update;
    if not found or t.expires_at <= clock_timestamp() or (t.chat_id is not null and t.chat_id <> actor) then
      message_text := 'Ссылка уже использована или её срок истёк. Откройте форму на сайте для нового обращения.';
    elsif t.chat_id = actor then
      message_text := 'Ваше обращение №' || t.number || ' уже подтверждено. Список доступен через /my.';
    elsif p_admin is null or p_admin <= 0 then
      message_text := 'Приём обращений временно недоступен.';
    else
      update requests_app.tickets set chat_id=actor, status='new' where number=t.number returning * into t;
      perform requests_app.queue(uid,'new-admin',p_admin,requests_app.card(t,true),true);
      perform requests_app.queue(uid,'new-client',actor,jsonb_build_object('text',
        'Обращение №' || t.number || ' принято. Статус: Новая. Ваши обращения — /my.'),true);
    end if;
  elsif action = 'list' and (ref = 'm' or (is_admin and ref in ('n','w','a'))) then
    message_text := case ref when 'm' then 'Ваши обращения' when 'n' then 'Новые обращения'
                    when 'w' then 'Обращения в работе' else 'Все обращения' end;
    if ref <> 'm' then
      keyboard := jsonb_build_array(jsonb_build_array(requests_app.button('Новые','l:n:0'),
        requests_app.button('В работе','l:w:0'), requests_app.button('Все','l:a:0')));
    end if;
    for item in
      select number, status, subject from requests_app.tickets
      where status <> 'draft' and (
        (ref='m' and chat_id=actor) or (is_admin and
          (ref='a' or (ref='n' and status='new') or (ref='w' and status='in_progress'))))
      order by number desc limit 9 offset page_no * 8
    loop
      i := i+1;
      exit when i=9;
      message_text := message_text || E'\n' || format('№%s · %s · %s',item.number,requests_app.status_label(item.status),item.subject);
      keyboard := keyboard || jsonb_build_array(jsonb_build_array(requests_app.button('№' || item.number,'c:' || item.number)));
    end loop;
    if i=0 then message_text := message_text || E'\nНа этой странице обращений нет.'; end if;
    if page_no>0 then
      keyboard := keyboard || jsonb_build_array(jsonb_build_array(requests_app.button('← Назад','l:' || ref || ':' || (page_no-1))));
    end if;
    if i=9 then
      keyboard := keyboard || jsonb_build_array(jsonb_build_array(requests_app.button('Дальше →','l:' || ref || ':' || (page_no+1))));
    end if;
  elsif action in ('retry_menu','retry') and is_admin then
    if action = 'retry' then
      update requests_app.outbox set state='pending', not_before=greatest(clock_timestamp(),not_before)
      where id=ref::bigint and state='failed' and retryable and not_before<=clock_timestamp();
      message_text := case when found then 'Повтор поставлен в очередь. Результат можно проверить через /retry.'
        else 'Повтор пока недоступен. Если Telegram ограничил частоту, попробуйте позже.' end;
    else
      message_text := 'Ошибки доставки';
      for item in select id, error_code, attempts from requests_app.outbox
        where state='failed' and retryable order by id desc limit 8 offset page_no * 7
      loop
        i := i+1;
        exit when i=8;
        message_text := message_text || E'\n' || format('№%s · %s · попыток: %s',item.id,item.error_code,item.attempts);
        keyboard := keyboard || jsonb_build_array(jsonb_build_array(requests_app.button('Повторить №' || item.id,'r:' || item.id)));
      end loop;
      if i=0 then message_text := message_text || E'\nНа этой странице ошибок нет.'; end if;
      if page_no>0 then
        keyboard := keyboard || jsonb_build_array(jsonb_build_array(requests_app.button('← Назад','e:' || (page_no-1))));
      end if;
      if i=8 then
        keyboard := keyboard || jsonb_build_array(jsonb_build_array(requests_app.button('Дальше →','e:' || (page_no+1))));
      end if;
    end if;
  elsif action in ('card','history','prompt','work','done') then
    select * into t from requests_app.tickets where number=ref::bigint and status<>'draft'
      and (chat_id=actor or is_admin) for update;
    if not found or (action in ('work','done') and not is_admin) then
      message_text := 'Обращение недоступно.';
    elsif action = 'card' then
      response := requests_app.card(t,is_admin);
    elsif action = 'history' then
      message_text := 'История обращения №' || t.number || ' · ' || requests_app.status_label(t.status);
      if page_no=0 then
        message_text := message_text || E'\n\nИсходное обращение: ' || t.subject || E'\n' || t.description;
        keyboard := jsonb_build_array(jsonb_build_array(requests_app.button('Переписка →','h:' || t.number || ':1')));
      else
        select * into item from requests_app.messages where ticket=t.number order by id desc limit 1 offset page_no-1;
        if found then
          message_text := message_text || E'\n\n' || to_char(item.created_at at time zone 'Europe/Moscow','DD.MM.YYYY HH24:MI')
            || ' МСК · ' || case item.sender when 'admin' then 'Кофейня' else 'Заявитель' end || E'\n' || item.body;
          if exists(select 1 from requests_app.messages where ticket=t.number and id<item.id) then
            keyboard := jsonb_build_array(jsonb_build_array(requests_app.button('Ранее →','h:' || t.number || ':' || (page_no+1))));
          end if;
        else
          message_text := message_text || E'\nСообщений на этой странице нет.';
        end if;
        keyboard := keyboard || jsonb_build_array(jsonb_build_array(requests_app.button('← Назад','h:' || t.number || ':' || (page_no-1))));
      end if;
      keyboard := keyboard || jsonb_build_array(jsonb_build_array(requests_app.button('К обращению','c:' || t.number)));
    elsif action = 'prompt' then
      prompt_id := gen_random_uuid();
      perform requests_app.queue(uid,'prompt',actor,
        jsonb_build_object('text',format('Ответьте на это сообщение по обращению №%s (до 2000 символов).%sКод подсказки: %s',
          t.number,E'\n',prompt_id),
          'reply_markup',jsonb_build_object('force_reply',true,'input_field_placeholder','Введите сообщение')),true,t.number,prompt_id);
    else
      new_status := case action when 'work' then 'in_progress' else 'done' end;
      if t.status <> new_status then
        update requests_app.tickets set status=new_status where number=t.number returning * into t;
        perform requests_app.queue(uid,'status-client',t.chat_id,jsonb_build_object('text',
          format('Обращение №%s. Новый статус: %s.',t.number,requests_app.status_label(t.status))),true);
      end if;
      response := requests_app.card(t,true);
    end if;
  elsif action = 'reply' then
    select state into prompt_state from requests_app.outbox where chat_id=actor
      and prompt_nonce=(p_event->>'nonce')::uuid for update;
    select * into pr from requests_app.prompts where chat_id=actor and message_id=(p_event->>'replyTo')::bigint for update;
    if not found then
      if prompt_state in ('processing','pending') then
        -- Raising rolls back the update marker. Telegram can deliver the same reply again.
        raise exception using errcode='40001', message='prompt_pending';
      end if;
      message_text := 'Откройте обращение через /my или /requests и запросите подсказку для ответа.';
    elsif pr.used_at is not null then
      message_text := 'Подсказка уже использована. Откройте обращение для нового сообщения.';
    else
      select * into t from requests_app.tickets where number=pr.ticket and status<>'draft'
        and (chat_id=actor or is_admin) for update;
      if not found or p_admin is null or p_admin <= 0 then
        message_text := 'Обращение недоступно.';
      elsif body is null or char_length(body) not between 1 and 2000 then
        message_text := 'Ответьте на подсказку текстом от 1 до 2000 символов.';
      else
        recipient := case when is_admin then t.chat_id else p_admin end;
        insert into requests_app.messages(ticket,update_id,sender,body)
          values(t.number,uid,case when is_admin then 'admin' else 'client' end,body);
        update requests_app.prompts set used_at=clock_timestamp() where chat_id=actor and message_id=pr.message_id;
        perform requests_app.queue(uid,'message',recipient,jsonb_build_object('text',
          format('%s по обращению №%s%s%s',case when is_admin then 'Ответ кофейни' else 'Уточнение заявителя' end,
            t.number,E'\n\n',body)),true);
        message_text := 'Сообщение сохранено и поставлено в очередь. Доставка подтверждается отдельно.';
      end if;
    end if;
  elsif action = 'start' then
    message_text := 'PUSHKINS COFFEE. Подтвердите обращение по ссылке с сайта. Ваши обращения — /my.';
    if is_admin then message_text := message_text || ' Список для владельца — /requests, ошибки доставки — /retry.'; end if;
  elsif action in ('retry_menu','retry','list') then
    message_text := 'Команда недоступна. Ваши обращения — /my.';
  else
    message_text := 'Выберите обращение через /my и нажмите «Написать уточнение».';
    if is_admin then message_text := message_text || ' Для ответа откройте /requests.'; end if;
  end if;
  if response is null and message_text is not null then
    response := jsonb_build_object('text',message_text);
    if keyboard <> '[]'::jsonb then
      response := response || jsonb_build_object('reply_markup',jsonb_build_object('inline_keyboard',keyboard));
    end if;
  end if;
  if response is not null then perform requests_app.queue(uid,'response',actor,response); end if;
  return jsonb_build_object('result','ok');
end $$;

create function public.nr_claim_outbox(p_update bigint default null)
returns jsonb language sql security definer set search_path = pg_catalog as $$
  with candidate as (
    select id from requests_app.outbox
    where (p_update is null or update_id=p_update)
      and ((state='pending' and not_before<=clock_timestamp())
        or (state='processing' and leased_until<=clock_timestamp()))
    order by id limit 1 for update skip locked
  ), claimed as (
    update requests_app.outbox o set state='processing', attempts=attempts+1,
      lease_token=gen_random_uuid(), leased_until=clock_timestamp()+interval '60 seconds'
    from candidate where o.id=candidate.id
    returning o.id::text, o.chat_id::text, o.lease_token, o.payload, o.prompt_ticket
  )
  select to_jsonb(claimed) from claimed
$$;

create function public.nr_delivered(p_id bigint,p_lease uuid,p_message bigint)
returns boolean language plpgsql security definer set search_path = pg_catalog as $$
declare
  o requests_app.outbox%rowtype;
  m requests_app.messages%rowtype;
begin
  if p_message is null or p_message <= 0 then return false; end if;
  update requests_app.outbox set state='sent', error_code=null, delivered_at=clock_timestamp(), lease_token=null, leased_until=null
    where id=p_id and state='processing' and lease_token=p_lease and leased_until>clock_timestamp()
    returning * into o;
  if not found then return false; end if;
  if o.prompt_ticket is not null then
    insert into requests_app.prompts(chat_id,message_id,ticket,outbox_id)
      values(o.chat_id,p_message,o.prompt_ticket,o.id);
  end if;
  if o.effect_key=o.update_id || ':message' then
    select * into m from requests_app.messages where update_id=o.update_id;
    perform requests_app.queue(o.update_id,'delivered', (select chat_id from requests_app.updates where id=o.update_id),
      jsonb_build_object('text',format('Сообщение по обращению №%s доставлено в чат Telegram.',m.ticket)));
  end if;
  return true;
end $$;

create function public.nr_failed(p_id bigint,p_lease uuid,p_error text,p_delay integer default 0)
returns boolean language plpgsql security definer set search_path = pg_catalog as $$
begin
  update requests_app.outbox set state='failed', error_code=p_error, lease_token=null, leased_until=null,
    not_before=clock_timestamp()+make_interval(secs=>greatest(0,least(p_delay,86400)))
    where id=p_id and state='processing' and lease_token=p_lease and leased_until>clock_timestamp();
  return found;
end $$;

create function public.nr_pending_count(p_update bigint)
returns integer language sql stable security definer set search_path = pg_catalog as $$
  select count(*)::integer from requests_app.outbox
  where update_id=p_update and state in ('pending','processing')
$$;

revoke execute on all functions in schema requests_app from public,anon,authenticated;
revoke execute on function public.nr_create_draft(uuid,text,text,text,text,text),
  public.nr_handle_update(jsonb,bigint), public.nr_claim_outbox(bigint),
  public.nr_delivered(bigint,uuid,bigint), public.nr_failed(bigint,uuid,text,integer),
  public.nr_pending_count(bigint) from public,anon,authenticated;
grant execute on function public.nr_create_draft(uuid,text,text,text,text,text),
  public.nr_handle_update(jsonb,bigint), public.nr_claim_outbox(bigint),
  public.nr_delivered(bigint,uuid,bigint), public.nr_failed(bigint,uuid,text,integer),
  public.nr_pending_count(bigint) to service_role;
commit;
