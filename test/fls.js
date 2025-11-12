const extractContentText = (text) => {
    const obj = JSON.parse(text)
    const time = new Date(obj._datetime_).toLocaleString()
    return obj._level_.toUpperCase() + ' ' + time + ' ' + obj._msg_
}

(text) => { const obj = JSON.parse(text);const time = new Date(obj._datetime_).toLocaleString();return obj._level_.toUpperCase() + ' ' + time + ' ' + obj._msg_}