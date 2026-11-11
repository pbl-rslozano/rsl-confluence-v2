import { pathToFileURL } from 'node:url';
export function assertReleaseMutationAllowed({requestedDraft,existingDraft,existingTarget,expectedTarget}) {
 if(existingTarget !== expectedTarget) throw new Error('Release tag points to another commit');
 if(requestedDraft && !existingDraft) throw new Error('Draft request cannot mutate a published release');
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 const [requestedDraft,existingDraft,existingTarget,expectedTarget]=process.argv.slice(2);
 if(!['true','false'].includes(requestedDraft)||!['true','false'].includes(existingDraft))throw new Error('Release draft state is missing or invalid');
 assertReleaseMutationAllowed({requestedDraft:requestedDraft==='true',existingDraft:existingDraft==='true',existingTarget,expectedTarget});
}
