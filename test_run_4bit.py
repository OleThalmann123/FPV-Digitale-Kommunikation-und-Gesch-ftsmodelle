import sys
from mlx_lm import load, generate
model, tokenizer = load("mlx-community/Apertus-8B-Instruct-2509-4bit")
prompt = "Hallo, wie geht es dir?"
response = generate(model, tokenizer, prompt=prompt, verbose=False, max_tokens=10)
print(response)
