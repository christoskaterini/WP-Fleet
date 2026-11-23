server {
        listen      %ip%:%web_port%;
        server_name %domain_idn% %alias_idn%;
        error_log   /var/log/%web_system%/domains/%domain%.error.log error;

        location ~ /\.(?!well-known\/|file) {
                deny all;
                return 404;
        }

        location / {
                proxy_pass http://127.0.0.1:3100;
                proxy_set_header Host $host;
                proxy_set_header X-Real-IP $remote_addr;
                proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
                proxy_set_header X-Forwarded-Proto $scheme;
                proxy_http_version 1.1;
                proxy_buffering off;
                proxy_cache off;
                proxy_read_timeout 3600s;
                chunked_transfer_encoding off;
        }

        include %home%/%user%/conf/web/%domain%/nginx.conf_*;
}
