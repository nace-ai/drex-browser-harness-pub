// llm.js makes every model call through send() (the AI SDK, streamed) and sizes it with countInput() (a local
// estimate). The tests fake replies in the request/answer shape llm.js uses, through llm.client.messages.create, and
// a few fake the token count through llm.client.messages.countTokens: a test's LLM answers with those fakes.
export const streamed = (llm) => {
  const estimate = llm.countInput.bind(llm);
  llm.client = { messages: {} };
  llm.send = (body, options) => llm.client.messages.create(body, options);
  llm.countInput = async (body) =>
    llm.client.messages.countTokens ? (await llm.client.messages.countTokens(body)).input_tokens : estimate(body);
  return llm;
};
