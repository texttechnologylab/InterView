FROM nginx:alpine

# Static site (landing page, interview routes, Janus demos under /demos/)
COPY janus-html /usr/share/nginx/html

# Custom nginx config with pretty routes for /interview and /interviewer
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Patch nginx mime.types to add .mjs and .wasm
RUN sed -i 's|application/javascript\s*js;|application/javascript js mjs;|' /etc/nginx/mime.types \
 && grep -q 'application/wasm' /etc/nginx/mime.types \
    || sed -i '/application\/javascript/a\    application/wasm                              wasm;' /etc/nginx/mime.types

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
