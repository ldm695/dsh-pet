(() => {
  window.__ModuleLoader__.load({
    id: 'dsh-pet-work-status-bridge',
    factory: (require) => {
      const React = require('react');
      const { useEffect } = React;
      let sequence = 0;

      function report(sessionId) {
        const revision = Date.now() * 1000 + (++sequence % 1000);
        void fetch('/dsh-pet-work-status-bridge-v1/selection', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, revision, focused: document.hasFocus() && !document.hidden }),
        }).catch(() => {});
      }

      function SelectedSessionReporter({ sessionId }) {
        useEffect(() => {
          const selected = typeof sessionId === 'string' ? sessionId : null;
          const reportFocus = () => report(selected);
          report(selected);
          const heartbeat = window.setInterval(() => report(selected), 2000);
          window.addEventListener('focus', reportFocus);
          window.addEventListener('blur', reportFocus);
          document.addEventListener('visibilitychange', reportFocus);
          return () => {
            window.clearInterval(heartbeat);
            window.removeEventListener('focus', reportFocus);
            window.removeEventListener('blur', reportFocus);
            document.removeEventListener('visibilitychange', reportFocus);
            report(null);
          };
        }, [sessionId]);
        return null;
      }

      return {
        name: 'dsh-pet-work-status-bridge-client',
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.inject('conversation.session.header.actions', function* () {
            yield ctx.slots.register(
              {
                name: 'conversation.session.header.actions',
                id: 'dsh-pet-work-status-bridge-reporter',
                order: -10000,
                inject: (sessionId) => ({ sessionId }),
              },
              SelectedSessionReporter,
            );
          });
        },
      };
    },
  });
})();
