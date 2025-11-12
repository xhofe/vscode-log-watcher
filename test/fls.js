const extractContentText = (text) => {
    const obj = JSON.parse(text)
    const time = new Date(obj._datetime_).toLocaleString()
    return time + ' ' + obj._level_.toUpperCase() + ' ' + obj._msg_
}

(text) => { const obj = JSON.parse(text);const time = new Date(obj._datetime_).toLocaleString();return time + ' ' + obj._level_.toUpperCase()  + ' ' + obj._msg_}