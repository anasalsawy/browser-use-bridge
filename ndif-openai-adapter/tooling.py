"""Qwen native chat-template tool formatting and strict response parsing.

No fake tool calls: fail if a requested function call isn't valid.
"""
import json
import re
import uuid

from fastapi import HTTPException
from jsonschema import Draft202012Validator, ValidationError


def prepared_messages(raw):
    output = []
    for m in raw:
        role = m.get("role")
        if role not in ("system", "developer", "user", "assistant", "tool"):
            raise HTTPException(400, "Unsupported message role")
        role = "system" if role == "developer" else role
        content = m.get("content") or ""
        if isinstance(content, list):
            if any(not isinstance(p, dict) or p.get("type") != "text" for p in content):
                raise HTTPException(400, "Only text inputs are supported")
            content = "\n".join(p.get("text", "") for p in content)
        if not isinstance(content, str):
            raise HTTPException(400, "Message content must be text")
        record = {"role": role, "content": content}
        if role == "tool":
            if not m.get("tool_call_id"):
                raise HTTPException(400, "Missing tool_call_id")
            # Qwen template uses role=tool and content; tool call correlation remains in history.
            record["tool_call_id"] = m["tool_call_id"]
        if role == "assistant" and m.get("tool_calls"):
            calls = []
            for call in m["tool_calls"]:
                fn = call.get("function") or {}
                arguments = fn.get("arguments", {})
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except ValueError:
                        raise HTTPException(400, "Invalid historical tool arguments")
                calls.append({"id": call.get("id"), "type": "function",
                              "function": {"name": fn.get("name"), "arguments": arguments}})
            record["tool_calls"] = calls
        output.append(record)
    return output


def choose_functions(tools, choice):
    if not tools or choice == "none":
        return None, "none"
    available = {}
    for tool in tools:
        if tool.get("type") != "function" or not isinstance(tool.get("function"), dict):
            raise HTTPException(400, "Only function tools are supported")
        fn = tool["function"]
        name = fn.get("name")
        if not isinstance(name, str) or not name or name in available:
            raise HTTPException(400, "Invalid or duplicate function name")
        schema = fn.get("parameters", {"type": "object"})
        try:
            Draft202012Validator.check_schema(schema)
        except Exception as exc:
            raise HTTPException(400, "Invalid function JSON schema") from exc
        available[name] = fn
    if isinstance(choice, dict):
        name = choice.get("function", {}).get("name")
        if name not in available:
            raise HTTPException(400, "Requested function was not supplied")
        return [available[name]], "required"
    if choice not in (None, "auto", "required", "none"):
        raise HTTPException(400, "Unsupported tool_choice")
    return list(available.values()), choice or "auto"


def render_prompt(tokenizer, messages, functions, choice):
    if not getattr(tokenizer, "chat_template", None):
        raise HTTPException(422, "Model tokenizer lacks chat_template")
    if functions:
        msgs = list(messages)
        if choice == "required":
            msgs.insert(0, {"role": "system", "content": "You must call an available function. Do not answer without a function call."})
        try:
            # Pass structured tools through Qwen's native Hugging Face chat template.
            return tokenizer.apply_chat_template(
                msgs, tools=[{"type": "function", "function": f} for f in functions],
                tokenize=False, add_generation_prompt=True)
        except Exception as exc:
            raise HTTPException(422, "Tokenizer does not support native tool templates") from exc
    return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)


def parse_calls(answer, functions, choice):
    if not functions:
        return None, answer
    found = []
    blocks = re.findall(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", answer, re.DOTALL)
    if blocks:
        for block in blocks:
            try:
                found.append(json.loads(block))
            except ValueError as exc:
                raise HTTPException(502, "Malformed model tool-call JSON") from exc
        remaining = re.sub(r"<tool_call>.*?</tool_call>", "", answer, flags=re.DOTALL).strip()
    else:
        remaining = answer
        stripped = answer.strip()
        if stripped.startswith("```"):
            stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", stripped)
        try:
            data = json.loads(stripped)
        except ValueError:
            data = None
        if isinstance(data, dict):
            if isinstance(data.get("tool_calls"), list):
                found = data["tool_calls"]
                remaining = ""
            elif "name" in data and "arguments" in data:
                found = [data]
                remaining = ""
    if not found:
        if choice == "required":
            raise HTTPException(502, "Model did not produce a required function call")
        return None, answer

    allowed = {f["name"]: f for f in functions}
    calls = []
    for call in found:
        if not isinstance(call, dict):
            raise HTTPException(502, "Invalid tool call object")
        fn = call.get("function", call)
        name = fn.get("name")
        arguments = fn.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except ValueError as exc:
                raise HTTPException(502, "Invalid generated function arguments") from exc
        if name not in allowed or not isinstance(arguments, dict):
            raise HTTPException(502, "Unknown function or invalid function arguments")
        try:
            Draft202012Validator(allowed[name].get("parameters", {"type": "object"})).validate(arguments)
        except ValidationError as exc:
            raise HTTPException(502, "Generated function arguments violate schema") from exc
        calls.append({"id": "call_" + uuid.uuid4().hex[:24], "type": "function",
                      "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}})
    return calls, remaining or None
