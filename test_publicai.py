import urllib.request
import json
import os

def check_models(api_key):
    url = "https://api.publicai.co/v1/models"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "Prompt-Platform-Test"
    })
    try:
        with urllib.request.urlopen(req) as response:
            return json.loads(response.read().decode())
    except Exception as e:
        print("Error fetching models:", e)
        return None

def test_chat_completion(api_key, model_id, prompt):
    url = "https://api.publicai.co/v1/chat/completions"
    data = json.dumps({
        "model": model_id,
        "messages": [{"role": "user", "content": prompt}]
    }).encode("utf-8")
    
    req = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": "Prompt-Platform-Test"
    })
    
    try:
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode())
            return result
    except Exception as e:
        print("Error with chat completion:", e)
        # return response payload if available
        if hasattr(e, 'read'):
            print("Response:", e.read().decode())
        return None

def main():
    api_key = os.environ.get("PUBLICAI_API_KEY", "")
    if not api_key:
        print("Fehler: PUBLICAI_API_KEY env var ist nicht gesetzt. In .env.local eintragen oder shell-export setzen.")
        return
    
    print("Testing Public AI API...")
    print("1. Fetching available models...")
    models_response = check_models(api_key)
    
    if models_response and "data" in models_response:
        models = [m["id"] for m in models_response["data"]]
        print(f"Erfolgreich geladen. Verfügbare Modelle: {', '.join(models)}")
    else:
        print("Konnte Modelle nicht laden.")
        return

    model_to_test = "swiss-ai/apertus-8b-instruct"
    test_prompt = "Hallo, wie kann ich dir heute helfen?"
    
    print(f"\n2. Testing Chat Completion with {model_to_test}...")
    print(f"Prompt: {test_prompt}")
    
    chat_response = test_chat_completion(api_key, model_to_test, test_prompt)
    
    if chat_response and "choices" in chat_response:
        content = chat_response["choices"][0]["message"]["content"]
        print("\n=== Antwort vom Modell ===")
        print(content)
        print("===========================")
    else:
        print("\nFehler bei der Generierung der Antwort.")

if __name__ == "__main__":
    main()
