// C-10: staff_override / session / password and manual / low assurance never meet an onsite requirement.
export default {
  post: (result: boolean, method: string | undefined, assurance: string | undefined, minimum: string): true | string => {
    if (!result) return true;
    if (method === 'staff_override' || method === 'session' || method === 'password') return 'rejected method was accepted';
    if (assurance !== 'high' && assurance !== 'medium') return 'manual / low assurance was accepted';
    return minimum !== 'high' || assurance === 'high' || 'medium assurance was accepted for a high requirement';
  },
};
