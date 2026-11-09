# StrideMail Bridge — puente IMAP/SMTP para @rentcar.rent

El navegador no puede hablar IMAP (993) ni SMTP (465) directamente.
Este puente es un servidorcito Node que sí puede: StrideMail le habla por
HTTPS y él entra a `mail.rentcar.rent` con tu correo y tu clave.

**Solo funciona con `@rentcar.rent`.** Las contraseñas nunca se guardan
en disco: solo viven en memoria, con un token que expira en 8 horas.

## Endpoints

- `GET /` y `GET /api/health` — salud del puente
- `POST /api/login` `{email, password}` — valida contra IMAP, devuelve `{token}`
- `GET /api/folders` — carpetas (con `x-token`, Basic Auth o `?email=&password=`)
- `GET /api/inbox?folder=INBOX&limit=50` — lista de mensajes
- `GET /api/message?folder=INBOX&uid=123` — un mensaje
- `POST /api/send` `{to, cc, bcc, subject, html, text}` — envía por SMTP 465

## Paso a paso: desplegar gratis en Render

### Paso 0 — Antes de empezar (5 min)
1. En Bluehost ve a **Email > cPanel Email > Email Accounts**.
2. Confirma que exista tu cuenta `@rentcar.rent` (por ejemplo
   `cheo@rentcar.rent`) y que sepas su contraseña. Si no existe, créala ahí.
   **No compartas esa contraseña por chat.**
3. Crea una cuenta gratis en https://github.com y otra en
   https://render.com (puedes entrar a Render con tu cuenta de GitHub).

### Paso 1 — Sube este proyecto a GitHub
1. En GitHub, **New repository**, nombre `stridemail-bridge`, **Public**,
   sin README inicial. Create repository.
2. En tu computadora, abre una terminal en esta carpeta y corre:
   ```
   git init
   git add .
   git commit -m "StrideMail Bridge v1"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/stridemail-bridge.git
   git push -u origin main
   ```
   Cambia `TU-USUARIO` por tu usuario de GitHub.
   Si no quieres usar terminal, en GitHub usa **Add file > Upload files**
   y sube todos los archivos de esta carpeta (menos `node_modules`).

### Paso 2 — Crea el servicio en Render
1. En Render: **New + > Web Service > Build and deploy from a Git repository > Next**.
2. Elige el repo `stridemail-bridge`. Si no aparece, dale **Configure account**
   y autoriza a Render a ver tus repos.
3. En la configuración pon exactamente:
   - **Name:** `stridemail-bridge`
   - **Region:** la más cercana (Oregon está bien)
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** **Free** (gratis)
4. En **Environment Variables** añade:
   - `STRICT_TLS` = `false`
   - `SESSION_TTL_HOURS` = `8`
   - `ALLOWED_ORIGIN` = (déjalo vacío por ahora; luego pon la URL de tu StrideMail)
5. Dale **Create Web Service**. Espera 2–5 minutos a que diga **Live**.

> Nota del plan gratis: Render duerme el servicio si nadie lo usa por
> un rato. El primer intento puede tardar 30–60 segundos en despertar.
> Es normal, no es un error. Si lo usas a diario, se mantiene despierto.

### Paso 3 — Prueba que el puente está vivo
Abre en el navegador la URL que te dio Render, por ejemplo:
`https://stridemail-bridge.onrender.com/api/health`

Tienes que ver algo como:
`{"ok":true,"service":"stridemail-bridge","domain":"rentcar.rent",...}`
Si ves eso, el puente está vivo. Copia esa URL base (sin `/api/health`).

### Paso 4 — Conéctalo en StrideMail
1. Abre StrideMail y entra con `cheo@rentcar.rent`.
2. Ve a **👑 Admin → Servidor cPanel**.
3. Pega la URL del puente (ej. `https://stridemail-bridge.onrender.com`),
   elige modo **En vivo** y dale **Probar conexión**.
4. Si dice **En vivo / Conectado**, entra a la bandeja: ya no es Demo,
   son tus correos reales de `rentcar.rent`.
5. Si dice error, vuelve a **Demo** (la app no se rompe) y revisa:
   - que la URL no tenga `/` al final ni `/api/health`,
   - que Render diga **Live**,
   - que la cuenta exista en Bluehost y la contraseña sea la correcta.

## Probar en tu computadora (opcional)
```
npm install
node server.js
```
Luego abre http://localhost:3000/api/health

## Seguridad
- Nunca subas un `.env` con contraseñas a GitHub.
- El puente solo acepta `@rentcar.rent`.
- Cuando StrideMail tenga su dominio final, pon esa URL en
  `ALLOWED_ORIGIN` en Render para que solo ella pueda usar el puente.
- Las sesiones expiran solas; para salir, usa **Cerrar sesión** en StrideMail.
