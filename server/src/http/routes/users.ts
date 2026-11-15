// People: your own account (/api/me), the directory everyone can read (for pickers and mentions),
// and adding, changing or deleting people (admins). Your own password stays at POST /api/auth/password.

import {
  CreateUserBody,
  UpdateMeBody,
  UpdateUserBody,
  type DeleteUserResponse,
  type MeResponse,
  type UpdateUserResponse,
  type UserInfo,
} from '@tt/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../../app';
import { hashPassword } from '../../auth/password';
import { unassignHiddenCards, unassignOpenCards } from '../../services/cards';
import { tx } from '../../services/context';
import { createUser, deleteUser, getUser, listUsers, meResponse, updateMe, updateUser } from '../../services/users';
import { ADMIN } from '../guard';
import { idParam, parse } from '../util';

export function registerUserRoutes(app: FastifyInstance, deps: AppDeps): void {
  const envOwner = () => deps.auth.passwordSource === 'env';
  const me = (req: FastifyRequest): MeResponse => meResponse(req.ctx, req.user!.id, envOwner());

  app.get('/api/me', async (req): Promise<MeResponse> => me(req));
  app.patch('/api/me', async (req): Promise<MeResponse> => {
    updateMe(req.ctx, req.user!.id, parse(UpdateMeBody, req.body));
    return me(req);
  });

  app.get('/api/users', async (req): Promise<UserInfo[]> => listUsers(req.ctx));
  app.post('/api/users', ADMIN, async (req, reply) => {
    const { password, ...body } = parse(CreateUserBody, req.body);
    const created = createUser(req.ctx, body, await hashPassword(password));
    req.log.info(`Added "${created.username}" (${created.role})`);
    return reply.status(201).send(created);
  });
  app.patch('/api/users/:id', ADMIN, async (req): Promise<UpdateUserResponse> => {
    const id = idParam(req);
    const { password, ...patch } = parse(UpdateUserBody, req.body);
    // Who the id means now: hashing takes a while, and a restore meanwhile could renumber people.
    const expectedUsername = getUser(req.ctx, id).username;
    const passwordHash = password === undefined ? undefined : await hashPassword(password);
    return tx(req.ctx, () => {
      const info = updateUser(req.ctx, id, patch, { passwordHash, ownerPasswordFromEnv: envOwner(), expectedUsername });
      // Narrowing someone's tags takes them off the cards they can no longer see, in the same change.
      const unassigned = patch.tagScope !== undefined && patch.tagScope !== null ? unassignHiddenCards(req.ctx, id) : 0;
      return { ...info, unassigned };
    });
  });
  // For good: the account is wiped down to its display name (services/users.ts deleteUser) and their
  // open cards go back to nobody, in one change.
  app.delete('/api/users/:id', ADMIN, async (req): Promise<DeleteUserResponse> => {
    const id = idParam(req);
    const { deleted, unassigned } = tx(req.ctx, () => {
      const deleted = deleteUser(req.ctx, id);
      return { deleted, unassigned: unassignOpenCards(req.ctx, id) };
    });
    req.log.info(`Deleted "${deleted.username}"${unassigned ? ` and unassigned ${unassigned} open card(s)` : ''}`);
    return { unassigned };
  });
}
