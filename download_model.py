import sys
from mlx_lm import load

def main():
    model_id = "swiss-ai/Apertus-8B-Instruct-2509"
    print(f"Lade Modell {model_id} herunter (kann je nach Internetverbindung dauern)...")
    
    # Durch Aufrufen von load wird das Modell automatisch von HuggingFace 
    # heruntergeladen und im Cache gespeichert.
    model, tokenizer = load(model_id)
    
    print("Download erfolgreich abgeschlossen! Das Modell ist nun gecached.")

if __name__ == "__main__":
    main()
