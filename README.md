# DAK Test Telegram Mini App

Bu loyiha mavjud `index.html` quiz ilovasini Telegram Mini App oqimiga ulaydi:

- foydalanuvchi botda `/start` bosadi;
- telefon raqamini Telegram kontakt sifatida yuboradi;
- `Ruxsat so'rash` tugmasi orqali adminga so'rov yuboradi;
- admin pastki klaviaturadan userlar ro'yxatini ochib, tanlangan user uchun ruxsat beradi yoki cheklaydi;
- admin telefon raqamlarni vergul bilan yuborib rejalashtirilgan ruxsatlar qo'sha oladi;
- tasdiqlangan foydalanuvchi Mini App ichida testlarni ishlaydi.

## Ishga tushirish

1. `.env.example` faylidan `.env` yarating.
2. `BOT_TOKEN` ga BotFather bergan tokenni yozing.
3. `ADMIN_IDS` ga adminlarning Telegram ID raqamlarini vergul bilan yozing.
4. `HISTORY_CHANNEL_ID` ga tarix yuboriladigan kanal ID sini yozing.
5. Botni tarix kanaliga admin qilib qo'shing.
6. `WEBAPP_URL` ga HTTPS domeningizni yozing.
7. Serverni ishga tushiring:

```bash
npm start
```

## Telegram sozlash

BotFather orqali botingiz uchun Web App URL sifatida `WEBAPP_URL` qiymatini kiriting. Productionda URL HTTPS bo'lishi kerak.

Admin botda `/start` bosganda pastki tugmalar chiqadi:

- `Barcha userlar ro'yxati`
- `Rejalashtirilgan ruxsatlar`
- `Telegram mini appni ochish`

`Rejalashtirilgan ruxsatlar` bosilgandan keyin raqamlarni vergul bilan yuboring:

```text
+998942203344, 942203344, +998 94 220 33 44, 94 220 33 44
```

Bot faqat to'g'ri O'zbekiston raqamlarini saqlaydi. Xato raqamlar sabab bilan qaytariladi. Shu raqamdagi foydalanuvchi keyin ruxsat so'rasa, avtomatik ruxsat beriladi.

## Local demo

`index.html` ni oddiy brauzerda ochsangiz, frontend local demo rejimida ishlaydi. Admin panelni local tekshirish uchun URL oxiriga `?admin=1` qo'shing.

Haqiqiy Telegram foydalanuvchi tasdiqlashi uchun `server.js` ishlashi kerak, chunki statik HTML admin qarorini boshqa foydalanuvchilarga xavfsiz ulasha olmaydi.
