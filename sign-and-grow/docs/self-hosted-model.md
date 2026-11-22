# A model of your own for the help chat

This page is for the people who run a GrowSigning server and want the help chat to be answered by a model they run
themselves, inside their own network. It is the only way a model answers on a server set up with
`DEPLOYMENT_PROFILE=government`, or with `OUTSIDE_CALLS=listed` or `none` (src/lib/chatboundary.ts). Without it the
help chat still works: it answers from the built-in help, and "Talk to a person" is under every answer.

The same model also writes documents in the app ("Write it") and, where an account's admin allows it, gives AI help
when sending and signing. One key, one address, one set of rules for all three.

## What the server does with it

- It sends a question to `SUPPORT_CHAT_BASE_URL` + `/chat/completions`, in the OpenAI chat format, streamed, with
  `max_tokens` 1200 and the model named in `SUPPORT_CHAT_MODEL`. It first asks for little thinking
  (`reasoning_effort: "low"`); a server that refuses that is asked once more without it.
- It sends the key in `SUPPORT_CHAT_API_KEY` as `Authorization: Bearer <key>`. A server that wants no key still needs
  some value there, because the setting is what switches the model on.
- What is sent: the system prompt (our own rules and the help pages) and what the person typed, after card numbers,
  private links, codes, passwords and email addresses that look like them are taken out. Never a document, a name,
  a signing link or anything that says who is asking. The model never sees documents, so there is nothing to search.
- What is kept: nothing of what is asked or answered. Only counts of questions, under keyed fingerprints, for up to
  two days, to hold the limits. A chat someone chooses to send with a help request becomes part of that request.
- Nothing is sent to train a model. Whether your model server keeps logs of its own is up to how you run it: switch
  its request logging off if you want nothing kept there either.

## Which addresses count

On a government or closed-network server, `SUPPORT_CHAT_BASE_URL` counts only when it is:

- a private network address: 10.x.x.x, 172.16.x.x to 172.31.x.x, 192.168.x.x, 100.64.x.x to 100.127.x.x, 127.x.x.x,
  fc00::/7, ::1, or `localhost`. Plain `http://` is accepted for these, because a model inside your network often has
  no certificate. Link-local addresses (169.254.x.x, fe80::) never count, because a cloud's metadata service usually
  lives there, and neither do the two metadata addresses known to sit inside the private ranges: AWS's fd00:ec2::/32
  and Alibaba Cloud's 100.100.100.200. Another cloud may use another address the server does not know: check yours.
- or a name you listed in `OUTBOUND_ALLOW`, over `https://`.

OpenRouter and Moonshot AI never count, even when listed, and however the address is written: with a dot at the end,
with a port, or as any name under openrouter.ai, moonshot.ai or moonshot.cn.

The public page `/security` prints the model's name and address, and an internal address such as 10.20.0.5:8000 is
then readable by anyone. If that should stay private, use a name instead (listed in `OUTBOUND_ALLOW`). The help
dialog shows the model line only to people signed in to the app, never to signers or visitors. When the setting does not count, the server says why in its
log when it starts, and the help chat answers from the built-in help. The server cannot check who runs the machine
behind an address: whoever sets it answers for that.

With `OUTSIDE_CALLS=none` the model's private address is the one private address the server's guard lets through
for this; no other service gets a private address by this rule.

## Running a model

Any server that speaks the OpenAI chat API with streaming works. Three common ones:

**vLLM** (a server with one or more NVIDIA GPUs):

```
vllm serve <model> --host 0.0.0.0 --port 8000 --api-key <a long random key>
```

then `SUPPORT_CHAT_BASE_URL=http://<its private address>:8000/v1`, `SUPPORT_CHAT_MODEL=<model>`,
`SUPPORT_CHAT_API_KEY=<the same key>`.

**llama.cpp server** (runs on CPUs, slower, with a GGUF file of the model):

```
llama-server -m <model>.gguf --host 0.0.0.0 --port 8080 --api-key <a long random key>
```

then `SUPPORT_CHAT_BASE_URL=http://<its private address>:8080/v1`. llama.cpp answers to any model name;
set `SUPPORT_CHAT_MODEL` to the file's model name so the pages name it truthfully.

**Ollama**:

```
OLLAMA_HOST=0.0.0.0 ollama serve
ollama pull <model>
```

then `SUPPORT_CHAT_BASE_URL=http://<its private address>:11434/v1`, `SUPPORT_CHAT_MODEL=<model>`, and any value in
`SUPPORT_CHAT_API_KEY` (Ollama does not check it, so keep its port closed to everything but the GrowSigning server).

Put the model server on the same private network as GrowSigning and let only GrowSigning reach its port.

## Which model

Kimi K3, the model the hosted setup uses, has open weights, but it is very large and needs a multi-GPU server; see
its model card for the hardware. A smaller open-weight instruction model works for this job, because the help chat
is told to answer only from our own rules and help pages, and every answer passes the same checks afterwards: no
promise that a signature is valid or will hold up, no refund promised, no em dashes. Choose one that follows
instructions well in the languages your people use, and try the questions in /help before you switch it on for
everyone. `SUPPORT_CHAT_DAILY_LIMIT` caps how many questions go to it in a day.

## The pages say what is true

/security ("Where your data is") and /security/processing name the model and the host from these settings. In the
app, the foot of the Help panel says "Answers come from <model> on <host>." Signers and visitors see only that
answers are written by AI and can be wrong. Each account's admin can switch AI answers off in Settings, and an
organisation above the account can switch it off for every account below it.

## What was tested

- The rules above, with a stand-in model server that speaks the OpenAI streaming format, in tests/gov-g20.test.ts:
  the hosted defaults refused under the government profile and under `OUTSIDE_CALLS=listed` and `none`, a private
  address and a listed name accepted, the guard allowing that one address and no other.
- Not tested: a real open-weight model. The machine this was built on could not download model weights (no access to
  the sites that publish them) and has no GPU. Try your model with the questions in /help before you rely on it.
