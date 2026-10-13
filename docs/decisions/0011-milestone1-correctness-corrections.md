# 0011 Milestone 1.1 correctness corrections

**Status:** Implemented by an external reviewer, then independently reviewed and extended in Milestone 1.2 (race, parallel-redemption and mutation tests). Executed through the sandbox harness only; see 0008 for the evidence boundary.

## Member removal must preserve the incident audit trail

The incidents table uses a composite foreign key from `(organization_id, assignee_id)` to memberships with `ON DELETE SET NULL`. Deleting a membership directly can therefore change an incident without inserting a timeline event. The application now handles member removal in one transaction: lock the membership, check the role rule, lock assigned incidents in a stable order, clear each assignment (which increments the incident version via the database trigger), append an `assigned` event recording the old member and `reason: "member_removed"`, then delete the membership. A rejected last-owner removal rolls back all of these writes.

**What actually provides the serialization (checked by mutation testing in Milestone 1.2).** Removal's exclusive `FOR UPDATE` on the membership row is the load-bearing lock: PostgreSQL's foreign-key check on any insert/update of `incidents.assignee_id` takes `FOR KEY SHARE` on that membership row, which conflicts with it. Either the assignment commits first (removal then sees and audits it) or removal commits first (the assignment's FK check fails and is reported as "assignee is not a member"). Removing that exclusive lock makes the race test fail. The explicit `FOR KEY SHARE` that `update` takes before locking the incident is defensive only: removing it did not fail any test, and it is not needed for deadlock freedom because both paths touch the membership row before incident rows. It is kept because it fixes the lock order explicitly, not because a test proves it necessary. The composite foreign key remains the final integrity safeguard.

## First-time invitation acceptance

The registration flow previously required an organization name for every new account, meaning a first-time invitee created an owned organization before accepting a colleague's invitation. `POST /api/auth/register-with-invite` now accepts the invite token as part of registration. Under one transaction it locks/validates the token, enforces the invited email, inserts the user and membership, marks the invitation accepted, and creates a session in the invited organization. It creates no extra organization. An existing account should sign in and use the existing invite-acceptance endpoint.

The team UI shows the full registration URL with the token in the URL fragment. Fragments are not included in HTTP requests/referrer headers; the registration page captures the token and immediately removes the fragment from the visible address bar. Tokens remain single-use, email-bound, and stored only as hashes.

## Evidence boundary

New integration/unit tests were added for audit-trail consistency, rollback of a failed last-owner removal, invite-registration atomicity, email mismatch, and API-client routing. This correction environment could not install the project's dependency tree from the npm registry, so those tests, actual NestJS wiring, real `pg` pool behaviour, and Next.js production build have **not** been claimed as executed here. The existing package lockfile was not changed because no dependencies were added.
