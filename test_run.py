import sys
print("starting import")
from mlx_lm import load, generate
print("starting load")
model, tokenizer = load("swiss-ai/Apertus-8B-Instruct-2509")
print("load complete, starting generate")
prompt = "Hi"
response = generate(model, tokenizer, prompt=prompt, verbose=False, max_tokens=10)
print(response)
