import sys
from mlx_lm import load, generate

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 run_mlx.py <model_id> <prompt_file>")
        sys.exit(1)
        
    model_id = sys.argv[1]
    prompt_file = sys.argv[2]
    
    with open(prompt_file, 'r', encoding='utf-8') as f:
        prompt = f.read()
    
    # Check if model is already localized or if it needs download
    model, tokenizer = load(model_id)
    
    # Generate
    response = generate(model, tokenizer, prompt=prompt, verbose=False, max_tokens=2048)
    print(response)

if __name__ == "__main__":
    main()
