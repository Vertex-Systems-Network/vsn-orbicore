import { verifyLegacySqliteScryptPassword } from "./legacy-scrypt-verifier.mjs";

// Synthetic source mutation permission proof ONLY. No production HTTP route
// imports this code. A live migration must additionally check real MFA,
// recovery policy, CSRF, session state and key custody.
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EMAIL=/^[^\s@]+@[^\s@]+\.(test|invalid)$/i;
const SELF=new Set(["password_reset","mfa_enrolled"]);
const OWNER_ONLY=new Set(["disabled","role_revoked"]);
export function requireCiMutationActorGate(){
  if(process.env.GITHUB_ACTIONS!=="true" ||
     process.env.ORBICORE_CI_SYNTHETIC_ACTOR_AUTH!=="1" ||
     process.env.ORBICORE_CI_SYNTHETIC_EVENT_ATTESTATION!=="1" ||
     process.env.ORBICORE_CI_SYNTHETIC_RECONCILE!=="1") {
    throw new Error("ci_mutation_actor_gate_required");
  }
}
export function verifyCiMutationActor({
  sqlite,actorId,actorPassword,targetUserId,kind,
}={}){
  requireCiMutationActorGate();
  if(!sqlite||typeof sqlite.prepare!=="function"||
     typeof actorId!=="string"||!ID.test(actorId)||
     typeof targetUserId!=="string"||!ID.test(targetUserId)||
     typeof actorPassword!=="string"||actorPassword.length<8||
     actorPassword.length>256||
     !(SELF.has(kind)||OWNER_ONLY.has(kind)))return false;
  const actor=sqlite.prepare(
    "SELECT id,organization_id,email,password_salt,password_hash,"+
    "role,disabled,mfa_enabled FROM users WHERE id=?",
  ).get(actorId);
  const target=sqlite.prepare(
    "SELECT id,organization_id,role,disabled,mfa_enabled "+
    "FROM users WHERE id=?",
  ).get(targetUserId);
  if(!actor||!target||actor.disabled!==0||actor.mfa_enabled!==0||
     actor.organization_id!==target.organization_id||
     !EMAIL.test(actor.email)||
     !verifyLegacySqliteScryptPassword({
       password:actorPassword,passwordSalt:actor.password_salt,
       passwordHash:actor.password_hash,
     }))return false;
  if(SELF.has(kind)){
    if(actorId!==targetUserId)return false;
    if(kind==="mfa_enrolled"&&target.mfa_enabled!==0)return false;
    return true;
  }
  // CI fixture never lets an owner lock out self or demote a different
  // owner. Cross-tenant roles, disabled actors, MFA-required actors are denied.
  return actor.role==="owner" && actorId!==targetUserId &&
    target.role!=="owner" &&
    (kind!=="disabled"||target.disabled===0);
}
