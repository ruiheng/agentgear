import { loadActionProducerManifest } from "./action-producer.mjs";

const declarations = loadActionProducerManifest(import.meta.url);

export const REVIEW_TASK_CONTEXT = declarations.actions.REVIEW_TASK_CONTEXT;
export const EXECUTE_DELEGATE_TASK = declarations.actions.EXECUTE_DELEGATE_TASK;
export const reviewTaskContextMessage = declarations.factories.REVIEW_TASK_CONTEXT;
export const executeDelegateTaskMessage = declarations.factories.EXECUTE_DELEGATE_TASK;
