export const RAG_LABELS = { hot: '★ Hot', strong: 'Strong', watch: 'Watch', avoid: 'Avoid' };
export const RAG_COLORS = { hot: '#f5c518', strong: '#2ecc71', watch: '#f59e0b', avoid: '#f87171' };

export function ragFromScore7(score) {
  if (score == null) return null;
  if (score === 7)   return 'hot';
  if (score >= 6)    return 'strong';
  if (score >= 4)    return 'watch';
  return 'avoid';
}
