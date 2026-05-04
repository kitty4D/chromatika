import { initTRPC } from '@trpc/server';
import superjson from 'superjson';

const t = initTRPC.context<{ userAgent?: string }>().create({
  transformer: superjson,
  /**
   * production extension builds set NODE_ENV=production so tRPC omits stacks by default.
   * prefix procedure path + a short stack tail so vague errors (e.g. ika private `.call`) are debuggable.
   */
  errorFormatter({ shape, path, error }) {
    const prefix = path ? `[${path}] ` : '';
    let message = `${prefix}${shape.message}`;
    const vague = /cannot read properties of undefined|reading 'call'/i.test(shape.message);
    if (vague && typeof error.stack === 'string') {
      const tail = error.stack
        .split('\n')
        .slice(0, 6)
        .map((l) => l.trim())
        .join(' ← ');
      message = `${message} · ${tail}`;
    }
    return { ...shape, message };
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;
