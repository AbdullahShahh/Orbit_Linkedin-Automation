// First guess of what a reply means – you can change it on the Pipeline page (then it stays as you set it).
//   negative: not interested / no need · positive: wants to talk, asks about price or details · unclear: anything else

const NEGATIVE = /\b(not interested|no thanks|no thank you|not (at|right) (the moment|now)|not now|no need|(do not|don't|doesn't|does not) (need|apply)|aren'?t interested|we'?re (good|all set|covered)|all set|not a fit|not for us|pass on this|please (stop|remove)|unsubscribe|not looking)\b/i;
const POSITIVE = /\b(let'?s (do it|talk|chat|connect|set|book)|interested|sounds (good|great|interesting)|tell me more|more (info|information|details)|what do you charge|how much|pric(e|es|ing)|cost|rates?|book (a )?(call|meeting)|schedule|calendly|available|free (on|this|next)|send (me|over)|happy to (chat|talk|connect)|sure|yes|yeah|absolutely)\b/i;

/** 'positive' | 'negative' | 'unclear' */
function categorizeReply(text = '') {
  const t = String(text).replace(/[’‘]/g, "'");
  if (NEGATIVE.test(t)) return 'negative';
  if (POSITIVE.test(t)) return 'positive';
  return 'unclear';
}

module.exports = { categorizeReply };
