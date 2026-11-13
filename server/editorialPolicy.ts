import { EditorialCurationStyle } from '../src/types/index.ts';

export interface EditorialPolicyRule {
  style: EditorialCurationStyle;
  label: string;
  minDuration: number;
  maxDuration: number;
  idealRange: string;
  guidance: string;
}

export const EDITORIAL_POLICIES: Record<EditorialCurationStyle, EditorialPolicyRule> = {
  viral_shorts: {
    style: 'viral_shorts',
    label: 'Viral Shorts / TikTok',
    minDuration: 30,
    maxDuration: 60,
    idealRange: '30-60s',
    guidance:
      'Target 30-60 seconds. Prefer complete stories, full explanations, strong opening hooks, and satisfying payoffs. NEVER return short 7-20s fragments for Viral Shorts.',
  },
  punchy_hooks: {
    style: 'punchy_hooks',
    label: 'Punchy Hooks & Micro-Moments',
    minDuration: 15,
    maxDuration: 30,
    idealRange: '15-30s',
    guidance:
      'Target 15-30 seconds. Prioritize lightning-fast opening hooks (0-3s), sharp curiosity gaps, and rapid micro-payoffs without filler.',
  },
  educational: {
    style: 'educational',
    label: 'Educational Nuggets & Pro Tips',
    minDuration: 20,
    maxDuration: 60,
    idealRange: '20-60s',
    guidance:
      'Target 20-60 seconds. Preserve complete context, clear problem setup, actionable explanation, and concrete takeaway so the lesson stands alone.',
  },
  storytelling: {
    style: 'storytelling',
    label: 'Storytelling & Emotional Climax',
    minDuration: 25,
    maxDuration: 60,
    idealRange: '25-60s',
    guidance:
      'Target 25-60 seconds. Preserve beginning, rising tension/development, turning point, and emotional payoff without cutting off mid-arc.',
  },
};

export function getEditorialPolicy(style?: EditorialCurationStyle | string): EditorialPolicyRule {
  if (style && style in EDITORIAL_POLICIES) {
    return EDITORIAL_POLICIES[style as EditorialCurationStyle];
  }
  return EDITORIAL_POLICIES.viral_shorts;
}

export function validateEditorialDuration(
  durationSec: number,
  style: EditorialCurationStyle
): { valid: boolean; reason?: string; policy: EditorialPolicyRule } {
  const policy = getEditorialPolicy(style);
  const rounded = Math.round(durationSec * 10) / 10;

  if (rounded < policy.minDuration - 0.5) {
    return {
      valid: false,
      policy,
      reason: `Duration (${rounded.toFixed(1)}s) is below ${policy.label} minimum (${policy.minDuration}s-${policy.maxDuration}s required; short fragments are not stretched or fabricated).`,
    };
  }

  if (rounded > policy.maxDuration + 1.0) {
    return {
      valid: false,
      policy,
      reason: `Duration (${rounded.toFixed(1)}s) exceeds ${policy.label} maximum (${policy.minDuration}s-${policy.maxDuration}s).`,
    };
  }

  return { valid: true, policy };
}
