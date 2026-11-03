# 0006 — Comprovantes

**Status:** aceita · 03/11/2026 · código: `apps/server/src/domain/attachments.ts`, `apps/server/src/storage/storage.ts`

## Decisão
- **Aceitos:** PDF, JPEG, PNG, WebP e HEIC/HEIF, **até 10 MB** cada, **até 5 por pagamento**. Tipo validado pelo **conteúdo** (`file-type`), não pela extensão.
- **Imagens:** HEIC → JPEG (`heic-convert`, WASM, sem dependência nativa); orientação aplicada e **todo o EXIF removido** (inclusive GPS) pelo `sharp`; lado maior limitado a 2000 px; JPEG qualidade 80 (PNG continua PNG). PDF vai como está.
- **No navegador:** fotos JPEG/PNG/WebP são reduzidas antes do envio (~2000 px); o campo usa `accept="image/*,application/pdf"` **sem `capture`**, para o celular oferecer câmera ou arquivos.
- **Criptografia na aplicação:** AES-256-GCM com a chave mestra `ATTACHMENTS_KEY` (32 bytes). Formato gravado: `"FF1"` + IV (12) + tag (16) + dados. O storage (R2 ou pasta local) só vê bytes cifrados.
- **Nome no storage:** `w/<walletId>/<uuid>`; o nome original (limpo) fica só no banco.
- **Download sempre pela API** (`GET /attachments/:id`), que confere a carteira; `Cache-Control: private, no-store`; **sem URL assinada e sem bucket público**.
- **Fluxo:** upload primeiro (`POST /attachments` → id) e vínculo no pagamento (`attachmentIds`), ou direto num pagamento existente. Um comprovante só pode estar num pagamento (ou grupo de parcelas pagas juntas).
- **Limpeza diária (worker):** órfãos com mais de 24 h e excluídos há mais de 30 dias são apagados do storage.
- **Drivers:** `STORAGE_DRIVER=local` (pasta, desenvolvimento) e `s3` (Cloudflare R2 ou qualquer S3).

## Consequências
- **Perder `ATTACHMENTS_KEY` = perder todos os comprovantes.** Guardar cópia num gerenciador de senhas. Trocar a chave exige recifrar (não implementado).
- A chave fica na VPS: protege contra vazamento do bucket/credencial, não contra a VPS comprometida.
