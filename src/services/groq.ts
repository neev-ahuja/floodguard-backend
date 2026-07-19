import { config } from '../config';

interface GroqClassification {
  intent: 'HELP' | 'SAFE' | 'URGENT' | 'MEDICAL' | 'EVACUATE' | 'OTHER';
  category: 'EVACUATION' | 'MEDICAL' | 'SUPPLY' | 'GENERAL' | 'UNKNOWN';
  urgency: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  cleaned: string;
}

const ALLOWED_INTENTS = ['HELP', 'SAFE', 'URGENT', 'MEDICAL', 'EVACUATE', 'OTHER'];
const ALLOWED_CATEGORIES = ['EVACUATION', 'MEDICAL', 'SUPPLY', 'GENERAL', 'UNKNOWN'];
const ALLOWED_URGENCIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

function isValidClassification(obj: unknown): obj is GroqClassification {
  if (!obj || typeof obj !== 'object') return false;
  const c = obj as Record<string, unknown>;
  return (
    typeof c.intent === 'string' && ALLOWED_INTENTS.includes(c.intent) &&
    typeof c.category === 'string' && ALLOWED_CATEGORIES.includes(c.category) &&
    typeof c.urgency === 'string' && ALLOWED_URGENCIES.includes(c.urgency) &&
    typeof c.cleaned === 'string'
  );
}

/**
 * Classifies a citizen message using Groq API.
 * NEVER sends access_token to Groq.
 * Only sends the message text.
 * Returns null on failure — never crashes.
 */
export async function classifyEmergencyMessage(
  messageText: string
): Promise<GroqClassification | null> {
  if (!config.groqApiKey) {
    console.warn('[GROQ] GROQ_API_KEY not configured. Skipping AI classification.');
    return null;
  }

  const prompt = `You are an emergency dispatcher AI. Classify the following citizen emergency message.
Return ONLY valid JSON with exactly these fields:
{
  "intent": "HELP"|"SAFE"|"URGENT"|"MEDICAL"|"EVACUATE"|"OTHER",
  "category": "EVACUATION"|"MEDICAL"|"SUPPLY"|"GENERAL"|"UNKNOWN",
  "urgency": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL",
  "cleaned": "<cleaned, professional summary of the situation in 1-2 sentences>"
}

Citizen message: "${messageText.substring(0, 500)}"`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.groqApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      console.error('[GROQ] API error:', response.status);
      return null;
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!isValidClassification(parsed)) {
      console.error('[GROQ] Invalid classification schema received');
      return null;
    }

    return parsed;
  } catch (err) {
    console.error('[GROQ] Classification failed:', err);
    return null;
  }
}
