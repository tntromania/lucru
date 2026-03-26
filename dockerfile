# Folosim o versiune oficiala si usoara de Node.js
FROM node:20-alpine

# Setam directorul de lucru in interiorul containerului
WORKDIR /app

# Copiem fisierele de configurare
COPY package*.json ./

# Instalam doar dependentele de care avem nevoie (fara cele de dezvoltare)
RUN npm install --production

# Copiem restul codului (server.js si folderul public)
COPY . .

# Expunem portul pe care ruleaza serverul nostru
EXPOSE 3000

# Comanda care porneste aplicatia
CMD ["npm", "start"]