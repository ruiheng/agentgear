import { loadActionProducerManifest } from "../../multi-agent-protocol/scripts/action-producer.mjs";

const declarations = loadActionProducerManifest(import.meta.url);

export const DESIGN_SPEC_REVIEW_CONTEXT = declarations.actions.DESIGN_SPEC_REVIEW_CONTEXT;
export const DESIGN_SPEC_DRAFT_REQUESTED = declarations.actions.DESIGN_SPEC_DRAFT_REQUESTED;
export const DESIGN_PRUNE_CONTEXT = declarations.actions.DESIGN_PRUNE_CONTEXT;
export const DESIGN_SPEC_REVIEW_REQUESTED = declarations.actions.DESIGN_SPEC_REVIEW_REQUESTED;
export const DESIGN_PRUNE_REQUESTED = declarations.actions.DESIGN_PRUNE_REQUESTED;
export const designSpecReviewContextMessage = declarations.factories.DESIGN_SPEC_REVIEW_CONTEXT;
export const designSpecDraftRequestedMessage = declarations.factories.DESIGN_SPEC_DRAFT_REQUESTED;
export const designPruneContextMessage = declarations.factories.DESIGN_PRUNE_CONTEXT;
export const designSpecReviewRequestedMessage = declarations.factories.DESIGN_SPEC_REVIEW_REQUESTED;
export const designPruneRequestedMessage = declarations.factories.DESIGN_PRUNE_REQUESTED;
export const sendDesignSpecReviewContextMessage = declarations.senders.DESIGN_SPEC_REVIEW_CONTEXT;
export const sendDesignSpecDraftRequestedMessage = declarations.senders.DESIGN_SPEC_DRAFT_REQUESTED;
export const sendDesignPruneContextMessage = declarations.senders.DESIGN_PRUNE_CONTEXT;
export const sendDesignSpecReviewRequestedMessage = declarations.senders.DESIGN_SPEC_REVIEW_REQUESTED;
export const sendDesignPruneRequestedMessage = declarations.senders.DESIGN_PRUNE_REQUESTED;
