import { ApiError, post } from '../api.ts';
import { h } from '../dom.ts';
import { navigate, type Page, type RouteCtx } from '../router.ts';
import { refreshSession } from '../session.ts';

export function loginPage(ctx: RouteCtx): Page {
  const next = ctx.query.get('next') ?? '';
  const err = h('div', { 'aria-live': 'assertive' });
  const user = h('input', {
    id: 'u',
    name: 'username',
    autocomplete: 'username',
    required: '',
    autocapitalize: 'none',
  });
  const pass = h('input', {
    id: 'p',
    name: 'password',
    type: 'password',
    autocomplete: 'current-password',
    required: '',
  });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h(
    'form',
    {
      class: 'card stack',
      onSubmit: async (e: Event) => {
        e.preventDefault();
        err.replaceChildren();
        btn.disabled = true;
        try {
          const r = await post<{ user: { role: 'organiser' | 'gate' } }>('/api/auth/login', {
            username: user.value,
            password: pass.value,
          });
          await refreshSession();
          navigate(next.startsWith('/') ? next : r.user.role === 'organiser' ? '/admin' : '/gate', true);
        } catch (ex) {
          err.replaceChildren(
            h(
              'p',
              { class: 'notice bad', role: 'alert' },
              ex instanceof ApiError ? ex.message : 'No connection. Try again.',
            ),
          );
          btn.disabled = false;
        }
      },
    },
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), user),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Password'), pass),
    btn,
    err,
    h(
      'p',
      { class: 'hint' },
      'Sample data: organiser / organiser-demo-pass, or gate1 / gate-demo-pass. These accounts exist only in the local seed.',
    ),
  );
  return {
    title: 'Staff sign-in',
    el: h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'ticket-page stack' },
        h('h1', null, 'Staff sign-in'),
        h('p', { class: 'muted' }, 'For organisers and gate staff.'),
        form,
      ),
    ),
  };
}
